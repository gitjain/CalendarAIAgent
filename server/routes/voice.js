const express = require('express');
const router = express.Router();
const VoiceAdapterFactory = require('../services/voice/VoiceAdapterFactory');
const calendarConflictService = require('../services/calendarConflictService');
const eventsStore = require('../services/eventsStore');
const wishlistStore = require('../services/wishlistStore');
const { getTranscriptionService } = require('../services/voice/transcriptionService');
const conversationSummarizer = require('../services/voice/conversationSummarizer');

function generateConversationId() {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureConversationStore(req) {
  if (!req.session) {
    return null;
  }
  if (!req.session.voiceConversations) {
    req.session.voiceConversations = {};
  }
  return req.session.voiceConversations;
}

function getConversation(req, conversationId) {
  if (!conversationId) {
    return null;
  }
  const store = ensureConversationStore(req);
  return store ? store[conversationId] || null : null;
}

function saveConversation(req, conversationId, conversation) {
  if (!conversationId) {
    return;
  }
  const store = ensureConversationStore(req);
  if (store) {
    store[conversationId] = {
      ...(store[conversationId] || {}),
      ...conversation,
      updatedAt: Date.now()
    };
  }
}

function clearConversation(req, conversationId) {
  if (!conversationId) {
    return;
  }
  const store = ensureConversationStore(req);
  if (store && store[conversationId]) {
    delete store[conversationId];
  }
}

/**
 * Extract the most recently mentioned event from conversation history
 * Useful for understanding references like "change that to 3pm" or "cancel that"
 */
function getLastMentionedEvent(conversationHistory) {
  if (!conversationHistory || conversationHistory.length === 0) {
    return null;
  }
  
  // Search backwards through history for event details
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const message = conversationHistory[i];
    
    // Look for assistant messages that might contain event confirmation
    if (message.role === 'assistant' && message.content) {
      // Try to extract event details from the message
      // This is a simple heuristic - the LLM should handle most context resolution
      const content = message.content.toLowerCase();
      
      // Check if this message is about an event
      if (content.includes('scheduled') || content.includes('created') || 
          content.includes('meeting') || content.includes('appointment') ||
          content.includes('event')) {
        
        // Try to extract basic info (title, date, time) from the message
        // This is a fallback - ideally the LLM uses full conversation context
        return {
          messageContent: message.content,
          timestamp: message.timestamp || Date.now()
        };
      }
    }
  }
  
  return null;
}

/**
 * Get conversation context summary for debugging
 */
function getConversationSummary(conversation) {
  if (!conversation) {
    return 'No active conversation';
  }
  
  const historyLength = conversation.conversationHistory ? conversation.conversationHistory.length / 2 : 0;
  const status = conversation.status || 'unknown';
  const hasEventDetails = conversation.eventDetails && Object.keys(conversation.eventDetails).length > 0;
  
  return {
    id: conversation.id,
    status: status,
    exchangeCount: Math.floor(historyLength),
    hasEventDetails: hasEventDetails,
    eventTitle: conversation.eventDetails?.title || null,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  };
}

function mergeEventDetails(base = {}, updates = {}) {
  const merged = { ...base };
  const fields = ['title', 'date', 'time', 'duration', 'location', 'description'];

  fields.forEach(field => {
    const value = updates[field];
    if (value !== undefined && value !== null && value !== '') {
      merged[field] = value;
    }
  });

  if (merged.duration === undefined) {
    merged.duration = 60;
  }

  return merged;
}

function hasMeaningfulEventDetails(details = {}) {
  if (!details) {
    return false;
  }
  return ['title', 'date', 'time', 'location', 'description'].some(field => {
    const value = details[field];
    return value !== undefined && value !== null && value !== '';
  });
}

// Initialize voice adapter
let voiceAdapter;
try {
  voiceAdapter = VoiceAdapterFactory.createAdapter();
  console.log(`✅ Voice Adapter initialized: ${process.env.VOICE_ADAPTER || 'mock'}`);
} catch (error) {
  console.error('❌ Failed to initialize voice adapter:', error);
  voiceAdapter = VoiceAdapterFactory.createAdapter('mock');
}

/**
 * Process voice transcript and parse intent with follow-up question support
 */
router.post('/process', async (req, res) => {
  try {
    const { transcript, context = {} } = req.body;

    if (!transcript || typeof transcript !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Transcript is required'
      });
    }

    // Extract conversation state from context
    let conversationHistory = context.conversationHistory || [];
    const followUpCount = context.followUpCount || 0;
    let conversationId = context.conversationId || null;
    let conversation = conversationId ? getConversation(req, conversationId) : null;
    
    // Get conversation history from stored conversation if available
    if (conversation && conversation.conversationHistory) {
      conversationHistory = conversation.conversationHistory;
    }

    // Parse intent and extract event details with conversation context
    const intentResult = await voiceAdapter.parseIntent(transcript, {
      currentDate: new Date().toISOString().split('T')[0],
      conversationHistory: conversationHistory,
      followUpCount: followUpCount,
      summary: conversation?.summary || null,
      ...context
    });

    const managesEventConversation = ['add_event', 'needs_clarification'].includes(intentResult.intent);
    const containsEventDetails = hasMeaningfulEventDetails(intentResult.eventDetails);

    if (managesEventConversation && containsEventDetails) {
      if (!conversation) {
        conversationId = generateConversationId();
        conversation = {
          id: conversationId,
          createdAt: Date.now(),
          status: 'collecting',
          eventDetails: {},
          alternatives: []
        };
      }

      const mergedDetails = mergeEventDetails(conversation.eventDetails, intentResult.eventDetails || {});
      conversation.eventDetails = mergedDetails;
      conversation.lastIntent = intentResult.intent;
      conversation.followUpCount = followUpCount;
      conversation.status = intentResult.intent === 'add_event' && intentResult.readyToProcess !== false
        ? 'ready'
        : conversation.status || 'collecting';

      saveConversation(req, conversationId, conversation);
      intentResult.eventDetails = mergedDetails;
    } else if (conversation) {
      // Merge any partial updates even if adapter didn't provide full details
      const mergedDetails = mergeEventDetails(conversation.eventDetails, intentResult.eventDetails || {});
      conversation.eventDetails = mergedDetails;
      saveConversation(req, conversationId, conversation);
      intentResult.eventDetails = mergedDetails;
    }

    if (intentResult.abort && conversationId) {
      clearConversation(req, conversationId);
      conversationId = null;
    }

    // Update conversation history with this exchange
    const aiResponse = intentResult.followUpQuestion || intentResult.response || 'Understood';
    const newHistory = [
      ...conversationHistory,
      { role: 'user', content: transcript },
      { role: 'assistant', content: aiResponse }
    ];
    
    // Save updated history to conversation with summarization
    if (conversation) {
      const lastSummarizedAt = conversation.lastSummarizedAt || 0;
      
      // Check if we should summarize
      if (conversationSummarizer.shouldSummarize(newHistory.length, lastSummarizedAt)) {
        console.log('📝 [Voice] Triggering summarization at', newHistory.length, 'messages');
        
        try {
          // Get messages to summarize and keep
          const { toSummarize, toKeep } = conversationSummarizer.getMessagesToSummarize(
            newHistory,
            lastSummarizedAt
          );
          
          // Generate summary
          const existingSummary = conversation.summary || null;
          const newSummary = await conversationSummarizer.summarizeConversation(
            toSummarize,
            existingSummary
          );
          
          // Update conversation with summary and recent history
          conversation.summary = newSummary;
          conversation.conversationHistory = toKeep;
          conversation.lastSummarizedAt = newHistory.length;
          
          console.log('✅ [Voice] Summarized', toSummarize.length, 'messages, keeping', toKeep.length);
        } catch (error) {
          console.error('❌ [Voice] Summarization failed:', error.message);
          // Fallback: keep last 8 messages without summary
          conversation.conversationHistory = newHistory.slice(-8);
        }
      } else {
        // No summarization needed yet, keep all history
        conversation.conversationHistory = newHistory;
      }
      
      conversation.followUpCount = followUpCount;
      saveConversation(req, conversationId, conversation);
    }

    res.json({
      success: true,
      intent: intentResult.intent,
      eventDetails: intentResult.eventDetails || {},
      wishlistItemId: intentResult.wishlistItemId || null,
      wishlistItemMatch: intentResult.wishlistItemMatch || null,
      updates: intentResult.updates || null,
      followUpQuestion: intentResult.followUpQuestion || null,
      missingInfo: intentResult.missingInfo || [],
      confidence: intentResult.confidence || 0.8,
      readyToProcess: intentResult.readyToProcess !== false,
      abort: intentResult.abort || false,
      abortMessage: intentResult.abortMessage || null,
      conversationHistory: conversation?.conversationHistory || [],
      conversationId: conversationId,
      historyLength: Math.floor((conversation?.conversationHistory?.length || 0) / 2)
    });
  } catch (error) {
    console.error('Error processing voice input:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process voice input'
    });
  }
});

/**
 * Transcribe raw audio (base64-encoded) using Whisper
 */
router.post('/transcribe', async (req, res) => {
  try {
    const { audio, mimeType, language = 'en', prompt = null } = req.body;

    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Audio data is required for transcription'
      });
    }

    const audioBuffer = Buffer.from(audio, 'base64');
    if (!audioBuffer.length) {
      return res.status(400).json({
        success: false,
        error: 'Received empty audio buffer'
      });
    }

    const transcriptionService = getTranscriptionService();
    if (!transcriptionService) {
      return res.status(503).json({
        success: false,
        error: 'Transcription service is not configured. Set OPENAI_API_KEY to enable Whisper.'
      });
    }

    const result = await transcriptionService.transcribeBuffer(audioBuffer, {
      mimeType,
      language,
      prompt
    });

    res.json({
      success: true,
      transcript: result.text,
      segments: result.segments,
      confidence: result.confidence
    });
  } catch (error) {
    console.error('Error transcribing audio input:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to transcribe audio'
    });
  }
});

/**
 * Check for conflicts and suggest alternatives
 */
/**
 * Normalize events to a format compatible with conflict checking
 * Handles both Google Calendar events (with ISO date strings) and mock events
 */
function normalizeEventsForConflictCheck(events) {
  return events.map(event => {
    let dateStr, timeStr, duration;
    
    // Skip all-day events - they don't have specific times and shouldn't participate in conflict checking
    if (event.allDay || (!event.date?.includes('T') && !event.time)) {
      // Silently skip all-day events - they're not time conflicts
      return null;
    }
    
    // Handle Google Calendar events (date is ISO string like "2024-01-15T14:30:00Z")
    if (event.date && (typeof event.date === 'string' && event.date.includes('T'))) {
      const dateTime = new Date(event.date);
      
      // Extract date in YYYY-MM-DD format (using local timezone to match conflict checker)
      const year = dateTime.getFullYear();
      const month = (dateTime.getMonth() + 1).toString().padStart(2, '0');
      const day = dateTime.getDate().toString().padStart(2, '0');
      dateStr = `${year}-${month}-${day}`;
      
      // Extract time in HH:MM format (using local timezone to match conflict checker)
      const hours = dateTime.getHours().toString().padStart(2, '0');
      const minutes = dateTime.getMinutes().toString().padStart(2, '0');
      timeStr = `${hours}:${minutes}`;
      
      // Calculate duration from endDate if available
      if (event.endDate) {
        const start = new Date(event.date);
        const end = new Date(event.endDate);
        duration = Math.round((end - start) / 60000); // Convert ms to minutes
      } else {
        duration = event.duration || 60;
      }
    } 
    // Handle Date objects
    else if (event.date instanceof Date) {
      const year = event.date.getFullYear();
      const month = (event.date.getMonth() + 1).toString().padStart(2, '0');
      const day = event.date.getDate().toString().padStart(2, '0');
      dateStr = `${year}-${month}-${day}`;
      const hours = event.date.getHours().toString().padStart(2, '0');
      const minutes = event.date.getMinutes().toString().padStart(2, '0');
      timeStr = `${hours}:${minutes}`;
      duration = event.duration || 60;
    }
    // Handle mock events with separate date and time fields
    else if (event.date && event.time) {
      // If date is already in YYYY-MM-DD format, use it; otherwise parse it
      if (typeof event.date === 'string' && event.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        dateStr = event.date;
      } else {
        const date = new Date(event.date);
        dateStr = date.toISOString().split('T')[0];
      }
      // Ensure time is in HH:MM format
      if (typeof event.time === 'string' && event.time.match(/^\d{1,2}:\d{2}$/)) {
        // Normalize time format (e.g., "9:30" -> "09:30")
        const [h, m] = event.time.split(':').map(Number);
        timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
      } else {
        timeStr = event.time;
      }
      duration = event.duration || 60;
    }
    // Fallback: try to parse any date-like field
    else {
      console.warn('Unable to normalize event for conflict check:', { 
        id: event.id, 
        title: event.title, 
        date: event.date,
        time: event.time 
      });
      return null;
    }
    
    return {
      ...event,
      date: dateStr,
      time: timeStr,
      duration: duration
    };
  }).filter(event => event !== null); // Remove null entries
}

router.post('/check-conflict', async (req, res) => {
  try {
    const { eventDetails, existingEvents, tokens, conversationId } = req.body;
    const conversation = conversationId ? getConversation(req, conversationId) : null;
    const normalizedEventDetails = mergeEventDetails(conversation?.eventDetails || {}, eventDetails || {});

    if (conversation) {
      conversation.eventDetails = normalizedEventDetails;
      conversation.status = 'checking_conflict';
      saveConversation(req, conversationId, conversation);
    }

    if (!normalizedEventDetails || !normalizedEventDetails.date || !normalizedEventDetails.time) {
      return res.status(400).json({
        success: false,
        error: 'Event details with date and time are required'
      });
    }

    // Normalize existing events to ensure they have date, time, and duration
    let events = existingEvents || [];
    events = normalizeEventsForConflictCheck(events);
    
    console.log(`📅 Checking conflicts against ${events.length} normalized events`);

    // If tokens provided, fetch real calendar events from Google Calendar
    if (tokens && tokens.access_token) {
      try {
        // Fetch Google Calendar events
        const { google } = require('googleapis');
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials(tokens);
        
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        
        // Get events for the next 30 days
        const now = new Date();
        const thirtyDaysLater = new Date();
        thirtyDaysLater.setDate(now.getDate() + 30);
        
        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin: now.toISOString(),
          timeMax: thirtyDaysLater.toISOString(),
          maxResults: 250,
          singleEvents: true,
          orderBy: 'startTime'
        });
        
        if (response.data.items) {
          const googleEvents = response.data.items.map(event => {
            const start = event.start?.dateTime || event.start?.date;
            const end = event.end?.dateTime || event.end?.date;
            return {
              id: event.id,
              title: event.summary || 'No Title',
              date: start,
              endDate: end,
              source: 'google'
            };
          });
          
          // Merge with existing events and normalize
          events = normalizeEventsForConflictCheck([...events, ...googleEvents]);
          console.log(`📅 Added ${googleEvents.length} Google Calendar events for conflict checking`);
        }
      } catch (googleError) {
        console.error('Error fetching Google Calendar events for conflict check:', googleError);
        // Continue with existing events if Google fetch fails
      }
    }

    // Check for conflicts
    const conflictResult = calendarConflictService.checkConflict(
      {
        date: normalizedEventDetails.date,
        time: normalizedEventDetails.time,
        duration: normalizedEventDetails.duration || 60
      },
      events
    );

    let alternatives = [];
    let conflictResponse = null;

    if (conflictResult.hasConflict) {
      // Find alternative slots
      const requestedDate = new Date(normalizedEventDetails.date + 'T00:00:00');
      alternatives = calendarConflictService.getAlternativeSuggestions(
        {
          date: normalizedEventDetails.date,
          duration: normalizedEventDetails.duration || 60
        },
        events,
        3
      );

      // Generate AI response with alternatives and override option
      conflictResponse = await voiceAdapter.generateConflictResponse(
        {
          conflictingEvent: conflictResult.conflictingEvent,
          requestedTime: normalizedEventDetails.time,
          requestedDate: normalizedEventDetails.date
        },
        alternatives
      );
    }

    if (conversation) {
      conversation.status = conflictResult.hasConflict ? 'awaiting_user_choice' : 'ready';
      conversation.alternatives = alternatives;
      conversation.lastConflict = conflictResult;
      saveConversation(req, conversationId, conversation);
    }

    res.json({
      success: true,
      hasConflict: conflictResult.hasConflict,
      conflictInfo: conflictResult.hasConflict ? {
        conflictingEvent: conflictResult.conflictingEvent,
        conflicts: conflictResult.conflicts
      } : null,
      alternatives: alternatives,
      response: conflictResponse || await voiceAdapter.generateResponse({
        type: 'success',
        message: 'No conflicts found'
      }),
      allowOverride: true, // Always allow double booking
      conversationId: conversationId
    });
  } catch (error) {
    console.error('Error checking conflict:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check conflict'
    });
  }
});

/**
 * Create calendar event (with optional override for conflicts)
 */
router.post('/create-event', async (req, res) => {
  try {
    const { eventDetails: incomingEventDetails, override = false, conversationId } = req.body;
    const conversation = conversationId ? getConversation(req, conversationId) : null;
    let eventDetails = mergeEventDetails(conversation?.eventDetails || {}, incomingEventDetails || {});

    if (conversation) {
      conversation.eventDetails = eventDetails;
      conversation.status = 'creating';
      saveConversation(req, conversationId, conversation);
    }

    // Use tokens from session instead of request body for security
    const tokens = req.session?.tokens || req.body.tokens;

    console.log(`📅 Creating voice event: ${eventDetails?.title}`);
    console.log(`🔑 Tokens available: ${!!tokens}, From session: ${!!req.session?.tokens}`);

    if (!eventDetails || !eventDetails.title || !eventDetails.date || !eventDetails.time) {
      return res.status(400).json({
        success: false,
        error: 'Event details with title, date, and time are required'
      });
    }

    // Validate event details
    const validation = voiceAdapter.validateEventDetails(eventDetails);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid event details',
        errors: validation.errors
      });
    }

    // LLM should return properly formatted date/time, but we validate and normalize here
    const duration = eventDetails.duration || 60; // Default 60 minutes
    const eventDate = eventDetails.date;
    let eventTime = eventDetails.time;
    
    // Normalize time format (LLM should return HH:MM, but handle edge cases)
    if (eventTime && !eventTime.includes(':')) {
      // Handle edge cases where time might not be properly formatted
      const timeMatch = eventTime.match(/(\d{1,2}):?(\d{2})?\s?(am|pm)?/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const period = timeMatch[3]?.toLowerCase();
        
        if (period === 'pm' && hours !== 12) hours += 12;
        if (period === 'am' && hours === 12) hours = 0;
        
        eventTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
      } else {
        return res.status(400).json({
          success: false,
          error: 'Invalid time format. Expected HH:MM format.'
        });
      }
    }
    
    // Validate and normalize date format (LLM should return YYYY-MM-DD)
    let normalizedDate = eventDate;
    if (!eventDate || !eventDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const dateObj = new Date(eventDate);
      if (isNaN(dateObj.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date format. Expected YYYY-MM-DD format.'
        });
      }
      // Use local timezone to avoid date shifting
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      normalizedDate = `${year}-${month}-${day}`;
    }
    
    eventDetails.time = eventTime;
    eventDetails.date = normalizedDate;
    
    // Create datetime string (local time)
    const startDateTime = `${normalizedDate}T${eventTime}:00`;
    const startDate = new Date(startDateTime);
    
    // Validate the date was parsed correctly
    if (isNaN(startDate.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date or time format. Unable to parse event date/time.'
      });
    }
    
    const endDate = new Date(startDate.getTime() + duration * 60000);

    // Create event object
    let event = {
      id: `voice_${Date.now()}`,
      title: eventDetails.title,
      date: startDate.toISOString(),
      endDate: endDate.toISOString(),
      time: eventTime,
      duration: duration,
      location: eventDetails.location || null,
      description: eventDetails.description || '',
      type: _determineEventType(eventDetails.title),
      source: tokens ? 'google' : 'voice',
      isAnalyzed: false,
      isAIGenerated: true
    };

    let eventCreatedInGoogle = false;

    // If Google Calendar tokens provided, create in Google Calendar
    if (tokens && tokens.access_token) {
      try {
        const { google } = require('googleapis');
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials(tokens);
        
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        
        // Get user's timezone (default to America/New_York if not available)
        // TODO: Get timezone from user preferences or detect from tokens
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
        
        // Format dates in the specified timezone for Google Calendar
        const formatDateTime = (date, timezone) => {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          const hours = String(date.getHours()).padStart(2, '0');
          const minutes = String(date.getMinutes()).padStart(2, '0');
          const seconds = String(date.getSeconds()).padStart(2, '0');
          return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
        };
        
        // Create event in Google Calendar
        const googleEvent = {
          summary: eventDetails.title,
          description: eventDetails.description || '',
          location: eventDetails.location || '',
          start: {
            dateTime: formatDateTime(startDate, timeZone),
            timeZone: timeZone
          },
          end: {
            dateTime: formatDateTime(endDate, timeZone),
            timeZone: timeZone
          },
          extendedProperties: {
            private: {
              isAIGenerated: 'true',
              createdByVoice: 'true'
            }
          }
        };
        
        console.log(`📅 Creating Google Calendar event:`, {
          title: googleEvent.summary,
          start: googleEvent.start.dateTime,
          timezone: timeZone
        });
        
        const createdEvent = await calendar.events.insert({
          calendarId: 'primary',
          resource: googleEvent
        });

        // Update event with Google Calendar data
        event.id = createdEvent.data.id;
        event.date = createdEvent.data.start.dateTime || createdEvent.data.start.date;
        event.endDate = createdEvent.data.end.dateTime || createdEvent.data.end.date;
        event.source = 'google';
        event.isAIGenerated = true; // Ensure this is set on the returned event
        eventCreatedInGoogle = true;

        console.log(`✅ Created event in Google Calendar: ${event.title} (ID: ${event.id})`);
        console.log(`🤖 AI-generated flag set: ${event.isAIGenerated}`);
      } catch (googleError) {
        console.error('❌ Error creating Google Calendar event:', googleError);
        console.error('Error details:', {
          message: googleError.message,
          code: googleError.code,
          response: googleError.response?.data
        });
        // Fall through to create in local events as fallback
        console.log('⚠️ Google Calendar creation failed, adding to local calendar');
        eventCreatedInGoogle = false;
        
        // If it's an authentication error, throw it so user knows to re-authenticate
        if (googleError.code === 401 || googleError.code === 403) {
          throw new Error('Google Calendar authentication failed. Please sign in again.');
        }
      }
    }

    // Add to local events store for UI updates
    // If created in Google Calendar, it will be fetched on next refresh
    // But we add it locally for immediate UI feedback
    if (!eventCreatedInGoogle) {
      // For non-Google events, add to local store
      eventsStore.addEvent(event);
    }
    // Note: Google Calendar events will appear automatically when calendar is refreshed
    // since they're fetched from Google Calendar API

    // Generate success response
    const response = await voiceAdapter.generateResponse({
      type: 'success',
      eventTitle: eventDetails.title,
      date: eventDetails.date,
      time: eventDetails.time,
      override: override,
      location: eventDetails.location
    });

    // Don't clear conversation after event creation - let it persist for follow-ups
    // User can explicitly end session when done with voice mode
    console.log('✅ [Voice] Event created, keeping conversation active for follow-ups');

    res.json({
      success: true,
      event: event,
      response: response,
      message: override ? 
        'Event created despite conflict. You chose to double book.' : 
        `Event created successfully${eventCreatedInGoogle ? ' in Google Calendar' : ' in local calendar'}`,
      createdInGoogle: eventCreatedInGoogle,
      conversationCleared: !!conversationId
    });
  } catch (error) {
    console.error('❌ Error in create-event endpoint:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create event',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Generate voice response for any scenario
 */
router.post('/generate-response', async (req, res) => {
  try {
    const { responseData } = req.body;

    if (!responseData) {
      return res.status(400).json({
        success: false,
        error: 'Response data is required'
      });
    }

    const response = await voiceAdapter.generateResponse(responseData);

    res.json({
      success: true,
      response: response
    });
  } catch (error) {
    console.error('Error generating response:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate response'
    });
  }
});

/**
 * Update wishlist item via voice
 */
router.post('/update-wishlist', async (req, res) => {
  try {
    const { wishlistItemId, wishlistItemMatch, updates } = req.body;
    const wishlistStore = require('../services/wishlistStore');

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Updates are required'
      });
    }

    let itemToUpdate = null;

    // Priority 1: Use LLM-provided ID (most accurate, semantic matching)
    if (wishlistItemId) {
      itemToUpdate = wishlistStore.getItemById(wishlistItemId);
      if (itemToUpdate) {
        console.log(`✅ Found wishlist item by LLM-provided ID: ${itemToUpdate.title}`);
      } else {
        console.warn(`⚠️ LLM provided ID "${wishlistItemId}" but item not found, falling back to keyword matching`);
      }
    }

    // Priority 2: Fallback to keyword matching (if LLM couldn't confidently match)
    if (!itemToUpdate && wishlistItemMatch) {
      const items = wishlistStore.getItems();
      const matchLower = wishlistItemMatch.toLowerCase();
      // Find best match (exact match preferred, then contains)
      itemToUpdate = items.find(item => 
        item.title.toLowerCase() === matchLower
      ) || items.find(item => 
        item.title.toLowerCase().includes(matchLower) ||
        matchLower.includes(item.title.toLowerCase())
      );
      
      if (itemToUpdate) {
        console.log(`✅ Found wishlist item by keyword match: ${itemToUpdate.title}`);
      }
    }

    if (!itemToUpdate) {
      return res.status(404).json({
        success: false,
        error: 'Wishlist item not found. Please specify which item to update (e.g., "update the museum visit").'
      });
    }

    const updated = wishlistStore.updateItem(itemToUpdate.id, updates);

    const response = await voiceAdapter.generateResponse({
      type: 'wishlist_updated',
      itemTitle: updated.title
    });

    res.json({
      success: true,
      item: updated,
      response: response || `Updated "${updated.title}" in your wishlist.`
    });
  } catch (error) {
    console.error('Error updating wishlist item:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update wishlist item'
    });
  }
});

/**
 * Delete wishlist item via voice
 */
router.post('/delete-wishlist', async (req, res) => {
  try {
    const { wishlistItemId, wishlistItemMatch } = req.body;
    const wishlistStore = require('../services/wishlistStore');

    let itemToDelete = null;

    // Priority 1: Use LLM-provided ID (most accurate, semantic matching)
    if (wishlistItemId) {
      itemToDelete = wishlistStore.getItemById(wishlistItemId);
      if (itemToDelete) {
        console.log(`✅ Found wishlist item by LLM-provided ID: ${itemToDelete.title}`);
      } else {
        console.warn(`⚠️ LLM provided ID "${wishlistItemId}" but item not found, falling back to keyword matching`);
      }
    }

    // Priority 2: Fallback to keyword matching (if LLM couldn't confidently match)
    if (!itemToDelete && wishlistItemMatch) {
      const items = wishlistStore.getItems();
      const matchLower = wishlistItemMatch.toLowerCase();
      // Find best match (exact match preferred, then contains)
      itemToDelete = items.find(item => 
        item.title.toLowerCase() === matchLower
      ) || items.find(item => 
        item.title.toLowerCase().includes(matchLower) ||
        matchLower.includes(item.title.toLowerCase())
      );
      
      if (itemToDelete) {
        console.log(`✅ Found wishlist item by keyword match: ${itemToDelete.title}`);
      }
    }

    if (!itemToDelete) {
      return res.status(404).json({
        success: false,
        error: 'Wishlist item not found. Please specify which item to delete (e.g., "delete the museum visit").'
      });
    }

    const deleted = wishlistStore.deleteItem(itemToDelete.id);

    const response = await voiceAdapter.generateResponse({
      type: 'wishlist_deleted',
      itemTitle: deleted.title
    });

    res.json({
      success: true,
      item: deleted,
      response: response || `Removed "${deleted.title}" from your wishlist.`
    });
  } catch (error) {
    console.error('Error deleting wishlist item:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete wishlist item'
    });
  }
});

/**
 * Add item to wishlist via voice
 */
router.post('/add-to-wishlist', async (req, res) => {
  try {
    const { eventDetails } = req.body;

    if (!eventDetails || !eventDetails.title) {
      return res.status(400).json({
        success: false,
        error: 'Event details with title are required'
      });
    }

    const wishlistItem = wishlistStore.addItem({
      title: eventDetails.title,
      description: eventDetails.description || null,
      date: eventDetails.date || null,
      time: eventDetails.time || null,
      priority: 'medium',
      location: eventDetails.location || null,
      category: null,
      source: 'voice'
    });

    const response = await voiceAdapter.generateResponse({
      type: 'wishlist_added',
      itemTitle: wishlistItem.title,
      hasDateTime: !!(wishlistItem.date && wishlistItem.time)
    });

    res.json({
      success: true,
      item: wishlistItem,
      response: response || `Added "${wishlistItem.title}" to your wishlist. I'll suggest it when you have free time!`
    });
  } catch (error) {
    console.error('Error adding to wishlist:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to add to wishlist'
    });
  }
});

router.post('/conversation/clear', (req, res) => {
  try {
    const { conversationId } = req.body;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: 'conversationId is required'
      });
    }

    clearConversation(req, conversationId);

    res.json({
      success: true
    });
  } catch (error) {
    console.error('Error clearing conversation context:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear conversation'
    });
  }
});

/**
 * End voice session - clear conversation when user exits voice mode
 */
router.post('/end-session', (req, res) => {
  try {
    const { conversationId } = req.body;

    if (conversationId) {
      console.log('🔚 [Voice] Ending session, clearing conversation:', conversationId);
      clearConversation(req, conversationId);
    }

    res.json({
      success: true,
      message: 'Voice session ended'
    });
  } catch (error) {
    console.error('Error ending voice session:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to end session'
    });
  }
});

function _determineEventType(title) {
  const lower = title.toLowerCase();
  if (lower.includes('dental') || lower.includes('doctor') || lower.includes('appointment')) {
    return 'Appointment';
  } else if (lower.includes('meeting')) {
    return 'Meeting';
  } else if (lower.includes('travel') || lower.includes('trip')) {
    return 'Travel';
  } else if (lower.includes('practice') || lower.includes('rehearsal')) {
    // Check practice BEFORE music/concert to avoid misclassification
    return 'Band Practice';
  } else if (lower.includes('concert') || lower.includes('show') || 
             (lower.includes('music') && !lower.includes('practice'))) {
    return 'Concert';
  }
  return 'General';
}

module.exports = router;

