require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const CalendarEventAnalyzer = require('./eventAnalyzer');
const eventsStore = require('./services/eventsStore');
const weatherService = require('./services/weatherService');
const uberRoutes = require('./routes/uber');
const googleCalendarRoutes = require('./routes/googleCalendar');
const voiceRoutes = require('./routes/voice');
const wishlistRoutes = require('./routes/wishlist');
const colorClassificationService = require('./services/colorClassificationService');
const taskCache = require('./services/taskCache');

const app = express();

function shouldAttemptMealPlanDetection(event) {
  if (!event) {
    console.log('[meal-plan-detection] No event provided');
    return false;
  }
  const text = `${event.title || ''} ${event.description || ''} ${event.type || ''}`.toLowerCase();
  console.log('[meal-plan-detection] Checking event:', {
    title: event.title,
    type: event.type,
    searchText: text,
    hasPrep: text.includes('prep')
  });
  
  if (!text.includes('prep')) {
    console.log('[meal-plan-detection] ❌ No "prep" keyword found');
    return false;
  }
  
  const mealKeywords = ['meal', 'lunch', 'dinner', 'breakfast', 'snack'];
  const foundKeyword = mealKeywords.find(keyword => text.includes(keyword));
  
  if (foundKeyword) {
    console.log('[meal-plan-detection] ✅ Meal prep event detected! Keyword:', foundKeyword);
    return true;
  }
  
  console.log('[meal-plan-detection] ❌ No meal keywords found. Checked:', mealKeywords);
  return false;
}

// Initialize the event analyzer
let eventAnalyzer;
try {
  eventAnalyzer = new CalendarEventAnalyzer();
  console.log('✅ OpenAI Event Analyzer initialized successfully');
} catch (error) {
  console.log('⚠️  OpenAI Event Analyzer initialization failed:', error.message);
  console.log('💡 Set OPENAI_API_KEY environment variable to enable AI analysis');
}
const PORT = process.env.PORT || 5001;
const ANALYSIS_TIMEOUT_MS = parseInt(process.env.EVENT_ANALYSIS_TIMEOUT_MS || '35000', 10);

/**
 * Ensure the analysis payload includes up-to-date weather information.
 * Refreshes cached analyses when the event is within the 7-day forecast window.
 */
async function refreshWeatherDataForAnalysis(analysis, event) {
  try {
    if (!analysis || !event) {
      return false;
    }

    const location = (event.location || '').trim();
    if (!location || !event.date) {
      return false;
    }

    const eventDate = new Date(event.date);
    if (Number.isNaN(eventDate.getTime())) {
      return false;
    }

    const now = new Date();
    if (eventDate <= now) {
      return false;
    }

    const hoursUntilEvent = (eventDate - now) / (1000 * 60 * 60);
    if (hoursUntilEvent > 168) {
      return false;
    }

    const existingWeather = analysis.weather || null;
    const existingTimestamp = existingWeather?.fetchedAt ? new Date(existingWeather.fetchedAt) : null;
    const existingLocation = existingWeather?.queryLocation ? existingWeather.queryLocation.toLowerCase() : '';
    const normalizedLocation = location.toLowerCase();

    const needsRefresh =
      !existingWeather ||
      !existingTimestamp ||
      (now - existingTimestamp) > 3 * 60 * 60 * 1000 ||
      existingLocation !== normalizedLocation;

    if (!needsRefresh) {
      return false;
    }

    const weatherData = await weatherService.getWeatherForEvent(location, event.date);
    if (!weatherData) {
      return false;
    }

    const weatherSuggestions = weatherService.generateWeatherSuggestions(
      weatherData,
      event.type,
      event.title
    );

    analysis.weather = {
      temperature: weatherData.temperature,
      feelsLike: weatherData.feelsLike,
      description: weatherData.description,
      main: weatherData.main,
      precipitation: Math.round(weatherData.precipitation),
      windSpeed: weatherData.windSpeed,
      humidity: weatherData.humidity,
      location: weatherData.location,
      suggestions: weatherSuggestions,
      fetchedAt: now.toISOString(),
      queryLocation: location
    };

    return true;
  } catch (error) {
    console.warn('Weather refresh failed:', error.message);
    return false;
  }
}

async function getLinkedTasksForEvent(eventId, req, options = {}) {
  if (!eventId) {
    return [];
  }

  const tokens = options.tokens || req.session?.tokens;
  const linkedTasks = [];

  if (tokens && tokens.access_token) {
    try {
      const { google } = require('googleapis');
      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials(tokens);

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const now = new Date();
      const ninetyDaysLater = new Date();
      ninetyDaysLater.setDate(now.getDate() + 90);

      let nextPageToken = null;
      do {
        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin: now.toISOString(),
          timeMax: ninetyDaysLater.toISOString(),
          maxResults: 250,
          singleEvents: true,
          orderBy: 'startTime',
          pageToken: nextPageToken || undefined
        });

        (response.data.items || []).forEach(event => {
          const originalEventId = event.extendedProperties?.private?.originalEventId;
          const isAIGenerated = event.extendedProperties?.private?.isAIGenerated === 'true';

          if (originalEventId === eventId && isAIGenerated) {
            linkedTasks.push({
              id: event.id,
              title: event.summary || 'Checklist Task',
              date: event.start?.dateTime || event.start?.date,
              endDate: event.end?.dateTime || event.end?.date,
              description: event.description || '',
              location: event.location || '',
              priority: event.extendedProperties?.private?.priority || null,
              category: event.extendedProperties?.private?.category || null,
              estimatedTime: event.extendedProperties?.private?.estimatedTime || null,
              originalEventId: originalEventId,
              originalEventTitle: event.extendedProperties?.private?.originalEventTitle || null,
              source: 'google',
              isAIGenerated: true
            });
          }
        });

        nextPageToken = response.data.nextPageToken;
      } while (nextPageToken);

    } catch (googleError) {
      console.error('❌ Error fetching linked tasks from Google Calendar:', googleError.message);
    }
  }

  if (linkedTasks.length === 0) {
    mockCalendarEvents.forEach(event => {
      if (event.originalEventId === eventId && event.isAIGenerated) {
        linkedTasks.push({ ...event });
      }
    });
  }

  return linkedTasks;
}

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'motherboard-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days in milliseconds
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// Helper function to generate dates relative to today
function getRelativeDate(daysFromToday, hour = 9, minute = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

// Mock calendar events template (dates will be generated dynamically)
const mockEventsTemplate = [
  {
    id: '1',
    title: 'Business Trip to New York',
    type: 'travel',
    daysFromToday: 5,
    startHour: 9,
    startMinute: 0,
    durationDays: 3,
    endHour: 18,
    endMinute: 0,
    description: 'Client meetings and conference attendance',
    location: 'New York, NY'
  },
  {
    id: '2',
    title: 'Rock Concert - The Electric Blues',
    type: 'concert',
    daysFromToday: 12,
    startHour: 20,
    startMinute: 0,
    durationDays: 0,
    endHour: 23,
    endMinute: 0,
    description: 'Live performance at Madison Square Garden',
    location: 'Madison Square Garden, NY'
  },
  {
    id: '3',
    title: 'Band Practice Session',
    type: 'band practice',
    daysFromToday: 3,
    startHour: 19,
    startMinute: 0,
    durationDays: 0,
    endHour: 22,
    endMinute: 0,
    description: 'Weekly practice for upcoming gig',
    location: 'Music Studio B, Downtown'
  },
  {
    id: '4',
    title: 'Airport Pickup - Sarah',
    type: 'pickup',
    daysFromToday: 7,
    startHour: 14,
    startMinute: 30,
    durationDays: 0,
    endHour: 16,
    endMinute: 0,
    description: 'Pick up Sarah from JFK Airport',
    location: 'JFK Airport Terminal 4'
  },
  {
    id: '5',
    title: 'Weekend Trip to Mountains',
    type: 'travel',
    daysFromToday: 14,
    startHour: 8,
    startMinute: 0,
    durationDays: 2,
    endHour: 20,
    endMinute: 0,
    description: 'Hiking and camping adventure',
    location: 'Rocky Mountain National Park'
  },
  {
    id: '6',
    title: 'Jazz Concert - Blue Note Quartet',
    type: 'concert',
    daysFromToday: 20,
    startHour: 19,
    startMinute: 30,
    durationDays: 0,
    endHour: 22,
    endMinute: 30,
    description: 'Intimate jazz performance',
    location: 'Blue Note Jazz Club'
  },
  {
    id: '7',
    title: 'Band Practice - New Songs',
    type: 'band practice',
    daysFromToday: 10,
    startHour: 18,
    startMinute: 0,
    durationDays: 0,
    endHour: 21,
    endMinute: 0,
    description: 'Learning new repertoire for winter performances',
    location: 'Community Center Room 3'
  },
  {
    id: '8',
    title: 'Family Pickup - Kids from School',
    type: 'pickup',
    daysFromToday: 4,
    startHour: 15,
    startMinute: 15,
    durationDays: 0,
    endHour: 16,
    endMinute: 0,
    description: 'Weekly pickup duty for soccer practice',
    location: 'Riverside Elementary School'
  },
  {
    id: '9',
    title: 'European Vacation',
    type: 'travel',
    daysFromToday: 25,
    startHour: 6,
    startMinute: 0,
    durationDays: 14,
    endHour: 22,
    endMinute: 0,
    description: 'Two-week tour of Italy and France',
    location: 'Europe'
  },
  {
    id: '10',
    title: 'Classical Concert - Symphony Orchestra',
    type: 'concert',
    daysFromToday: 22,
    startHour: 20,
    startMinute: 0,
    durationDays: 0,
    endHour: 22,
    endMinute: 30,
    description: 'Beethoven\'s 9th Symphony performance',
    location: 'Lincoln Center'
  }
];

// Function to generate fresh events with current dates
function generateMockEvents() {
  return mockEventsTemplate.map(template => ({
    id: template.id,
    title: template.title,
    type: template.type,
    date: getRelativeDate(template.daysFromToday, template.startHour, template.startMinute),
    endDate: getRelativeDate(template.daysFromToday + template.durationDays, template.endHour, template.endMinute),
    description: template.description,
    location: template.location,
    isAnalyzed: false,
    aiGenerated: false
  }));
  }

// Initialize with fresh mock events
let mockCalendarEvents = generateMockEvents();

// Routes
// Color classification endpoint (for LLM fallback if needed)
app.post('/api/calendar/color-classify', async (req, res) => {
  try {
    const { event } = req.body;
    
    if (!event || !event.title) {
      return res.status(400).json({
        success: false,
        error: 'Event with title is required'
      });
    }

    const colorClass = await colorClassificationService.getColorClass(event);
    
    res.json({
      success: true,
      colorClass: colorClass,
      cacheSize: colorClassificationService.getCacheSize()
    });
  } catch (error) {
    console.error('Error classifying event color:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to classify event color'
    });
  }
});

app.get('/api/calendar/events', (req, res) => {
  try {
    // Regenerate mock events with fresh dates based on today
    const baseEvents = generateMockEvents();
    
    // Preserve isAnalyzed and linkedTaskCount from existing events
    const preservedStates = new Map();
    mockCalendarEvents.forEach(event => {
      if (event.isAnalyzed || event.linkedTaskCount) {
        preservedStates.set(event.id || event.eventId, {
          isAnalyzed: event.isAnalyzed,
          analyzedAt: event.analyzedAt,
          linkedTaskCount: event.linkedTaskCount
        });
      }
    });
    
    // Apply preserved states to regenerated events
    baseEvents.forEach(event => {
      const preserved = preservedStates.get(event.id);
      if (preserved) {
        event.isAnalyzed = preserved.isAnalyzed;
        event.analyzedAt = preserved.analyzedAt;
        event.linkedTaskCount = preserved.linkedTaskCount;
      }
    });
    
    // Merge with any AI-generated events that were added
    const aiGeneratedEvents = mockCalendarEvents.filter(e => e.isAIGenerated);
    const freshEvents = [...baseEvents, ...aiGeneratedEvents];
    
    // Update the global mockCalendarEvents array
    mockCalendarEvents = freshEvents;
    
    // Simulate API delay
    setTimeout(() => {
      res.json({
        success: true,
        events: freshEvents,
        message: 'Calendar events retrieved successfully'
      });
    }, 500);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve calendar events',
      error: error.message
    });
  }
});

// Event analysis endpoint
app.post('/api/analyze-event', async (req, res) => {
  try {
    const { eventId, event, forceReanalyze = false } = req.body;
    
    if (!eventId && !event) {
      return res.status(400).json({
        success: false,
        message: 'Event ID or event data is required'
      });
    }

    let eventToAnalyze;
    
    // If event data is provided directly (from Google Calendar), use it
    if (event) {
      eventToAnalyze = event;
    } else {
      // Otherwise, find the event by ID in mock events
      eventToAnalyze = mockCalendarEvents.find(e => e.id === eventId);
      
      if (!eventToAnalyze) {
        return res.status(404).json({
          success: false,
          message: 'Event not found'
        });
      }
    }

    // Check if event is an AI-generated checklist task (these should never be analyzed)
    if (eventToAnalyze.isAIGenerated) {
      return res.status(400).json({
        success: false,
        message: 'AI-generated checklist tasks cannot be analyzed'
      });
    }

    // Check if event has already been analyzed (from metadata)
    const eventIdentifier = eventToAnalyze.id || eventToAnalyze.eventId;
    const shouldForceReanalyze = Boolean(forceReanalyze);
    const isAlreadyAnalyzed = eventToAnalyze.isAnalyzed || eventToAnalyze.extendedProperties?.private?.isAnalyzed === 'true';
    const cachedTasks = eventIdentifier ? taskCache.getRemainingTasks(eventIdentifier) : null;

    if (shouldForceReanalyze) {
      let extendedProps = eventToAnalyze.extendedProperties;

      if (extendedProps?.private) {
        extendedProps = {
          ...extendedProps,
          private: {
            ...extendedProps.private,
            isAnalyzed: 'false'
          }
        };
      } else if (extendedProps) {
        extendedProps = {
          ...extendedProps
        };
      }

      eventToAnalyze = {
        ...eventToAnalyze,
        isAnalyzed: false,
        extendedProperties: extendedProps
      };

      if (eventIdentifier) {
        taskCache.clear(eventIdentifier);
      }
    }

    if (isAlreadyAnalyzed && !shouldForceReanalyze) {
      const remainingTasks = Array.isArray(cachedTasks) ? cachedTasks : [];
      const linkedTasks = eventIdentifier ? await getLinkedTasksForEvent(eventIdentifier, req) : [];
      console.log('📦 Cached analysis hit:', {
        eventId: eventIdentifier,
        remainingCount: remainingTasks.length,
        linkedCount: linkedTasks.length
      });
      
      // If both remaining and linked tasks are 0, this event was incorrectly marked as analyzed
      // OR the linked tasks were deleted from Google Calendar
      // Force re-analysis instead of returning empty cache
      if (remainingTasks.length === 0 && linkedTasks.length === 0) {
        console.log('⚠️  Event marked as analyzed but has no tasks - forcing re-analysis');
        console.log('🗑️  Clearing cache and resetting analyzed flag');
        
        // Clear the cache
        if (eventIdentifier) {
          taskCache.clear(eventIdentifier);
        }
        
        // Reset analyzed flag
        eventToAnalyze = {
          ...eventToAnalyze,
          isAnalyzed: false
        };
        
        // Fall through to normal analysis below
      } else {
 
      const analysisPayload = {
        eventSummary: `Remaining checklist items for ${eventToAnalyze.title || 'this event'}`,
        preparationTasks: remainingTasks,
        timeline: { timeframe: [] },
        tips: [],
        estimatedPrepTime: remainingTasks.length > 0 ? 'Pending tasks remaining' : '0 minutes remaining',
        requiresMealPlanPreferences: false,
        remainingTasksOnly: true,
        allTasksScheduled: remainingTasks.length === 0,
        linkedTasks: linkedTasks,
        totalLinkedTasks: linkedTasks.length,
        remainingTaskCount: remainingTasks.length
      };

        return res.json({
          success: true,
          event: { ...eventToAnalyze, isAnalyzed: true },
          analysis: analysisPayload,
          message: remainingTasks.length > 0
            ? 'Loaded remaining checklist items that have not been added to your calendar.'
            : linkedTasks.length > 0
              ? 'All checklist items are on your calendar. Review them below.'
              : 'No checklist items were generated for this event.'
        });
      }
    }

    const shouldAttemptMealPlan = shouldAttemptMealPlanDetection(eventToAnalyze);

    // Check if event analyzer is available
    if (!eventAnalyzer) {
      return res.status(503).json({
        success: false,
        message: 'AI Event Analysis is not available. Please set OPENAI_API_KEY environment variable.'
      });
    }

    let analysis;

    // Get Google OAuth tokens for document processing (if available)
    const tokens = req.session?.tokens || null;
    
    // Extract meal plan preferences from request body if provided
    const mealPlanPreferences = req.body.mealPlanPreferences || null;
    
    console.log('[analysis] Request body keys:', Object.keys(req.body));
    console.log('[analysis] mealPlanPreferences from body:', mealPlanPreferences);
    console.log('[analysis] shouldAttemptMealPlan from body:', req.body.shouldAttemptMealPlan);
    
    const analysisStart = Date.now();
    const analysisLogContext = {
      eventId: eventIdentifier,
      title: eventToAnalyze.title,
      source: eventToAnalyze.source || 'mock',
      shouldAttemptMealPlan,
      hasMealPlanPrefs: !!mealPlanPreferences,
      forceReanalyze: shouldForceReanalyze
    };

    console.log('[analysis] server_start', {
      ...analysisLogContext,
      timeoutMs: ANALYSIS_TIMEOUT_MS
    });

    const timeoutError = new Error('analysis_timeout');
    timeoutError.isAnalysisTimeout = true;
    let analysisTimeoutId;

    try {
      const analysisPromise = eventAnalyzer.analyzeEvent(eventToAnalyze, tokens, { 
        shouldAttemptMealPlan,
        mealPlanPreferences
      });
      const timeoutPromise = new Promise((_, reject) => {
        analysisTimeoutId = setTimeout(() => reject(timeoutError), ANALYSIS_TIMEOUT_MS);
      });

      analysis = await Promise.race([analysisPromise, timeoutPromise]);

      console.log('[analysis] server_success', {
        ...analysisLogContext,
        durationMs: Date.now() - analysisStart
      });
    } catch (analysisError) {
      console.error('[analysis] server_failure', {
        ...analysisLogContext,
        durationMs: Date.now() - analysisStart,
        message: analysisError.message
      });

      if (analysisError.isAnalysisTimeout) {
        return res.status(504).json({
          success: false,
          message: 'Event analysis timed out. Please try again.'
        });
      }
      throw analysisError;
    } finally {
      clearTimeout(analysisTimeoutId);
    }

    // Refresh weather data when needed
    await refreshWeatherDataForAnalysis(analysis, eventToAnalyze);
    if (eventIdentifier) {
      const tasks = analysis.preparationTasks || [];
      console.log(`💾 [TaskCache] Storing ${tasks.length} initial tasks for event:`, eventIdentifier);
      console.log(`📋 [TaskCache] Tasks:`, tasks.map(t => t.task || t.title));
      taskCache.setRemainingTasks(eventIdentifier, tasks);
    }

    const linkedTasks = eventIdentifier ? await getLinkedTasksForEvent(eventIdentifier, req) : [];
    analysis.linkedTasks = linkedTasks;
    analysis.remainingTasksOnly = false;
    analysis.remainingTaskCount = Array.isArray(analysis.preparationTasks) ? analysis.preparationTasks.length : 0;
    analysis.totalLinkedTasks = linkedTasks.length;

    if (Array.isArray(analysis.preparationTasks)) {
      const sampleTasks = analysis.preparationTasks.slice(0, 3).map(task => ({
        id: task.id,
        description: task.description
      }));
      console.log('🧾 Preparation task sample:', sampleTasks);
    }

    if (analysis.mealPlan) {
      console.log('🥘 Meal plan summary:', {
        hasMeals: Boolean(analysis.mealPlan.meals),
        mealCount: analysis.mealPlan.meals?.length || 0,
        source: analysis.mealPlan.source
      });
    }
 
    // Don't mark the event as analyzed yet - wait until tasks are added
    // If this event is in Google Calendar, remove the isAnalyzed flag
    if (tokens && tokens.access_token && eventIdentifier && eventToAnalyze.source === 'google') {
      try {
        const { google } = require('googleapis');
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials(tokens);
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

        await calendar.events.patch({
          calendarId: 'primary',
          eventId: eventIdentifier,
          resource: {
            extendedProperties: {
              private: {
                isAnalyzed: 'false'
              }
            }
          }
        });
        console.log(`🔄 Removed analyzed flag from Google Calendar event: ${eventIdentifier}`);
      } catch (patchError) {
        console.error('⚠️ Failed to remove analyzed flag from Google Calendar:', patchError.message);
      }
    }
    
    res.json({
      success: true,
      event: { ...eventToAnalyze, isAnalyzed: false }, // Return as not analyzed until tasks are added
      analysis: analysis,
      message: 'Event analyzed successfully'
    });
  } catch (error) {
    console.error('Error analyzing event:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to analyze event',
      error: error.message
    });
  }
});

// Generate meal plan with user preferences
app.post('/api/generate-meal-plan', async (req, res) => {
  try {
    const { event, preferences } = req.body;
    const tokens = req.session?.tokens;

    if (!event) {
      return res.status(400).json({
        success: false,
        message: 'Event data is required'
      });
    }

    if (!preferences) {
      return res.status(400).json({
        success: false,
        message: 'Meal plan preferences are required'
      });
    }

    console.log('🍽️ [Generate Meal Plan] Request received:', {
      eventTitle: event.title,
      preferences: preferences,
      hasTokens: !!tokens?.access_token
    });

    // Check if this is a meal prep event
    const shouldAttemptMealPlan = shouldAttemptMealPlanDetection(event);
    
    if (!shouldAttemptMealPlan) {
      return res.status(400).json({
        success: false,
        message: 'This event does not appear to be a meal prep event'
      });
    }

    // Re-analyze the event with meal plan preferences
    try {
      const mealPlanPreferences = {
        days: preferences.days || 7,
        people: preferences.familySize || preferences.people || 2,
        targetCalories: preferences.targetCalories || 2000,
        diet: preferences.diet || 'balanced',
        exclude: preferences.exclude || ''
      };

      console.log('🍽️ [Generate Meal Plan] Analyzing event with preferences:', mealPlanPreferences);

      const analysis = await eventAnalyzer.analyzeEvent(event, tokens, {
        shouldAttemptMealPlan: true,
        mealPlanPreferences: mealPlanPreferences
      });

      console.log('🍽️ [Generate Meal Plan] Analysis complete:', {
        hasMealPlan: !!analysis.mealPlan,
        mealPlanSource: analysis.mealPlan?.source,
        requiresPreferences: analysis.requiresMealPlanPreferences
      });

      if (analysis.mealPlan && (analysis.mealPlan.meals || analysis.mealPlan.fallback || analysis.mealPlan.formattedText)) {
        return res.json({
          success: true,
          analysis: analysis,
          message: 'Meal plan generated successfully'
        });
      } else {
        return res.status(500).json({
          success: false,
          message: analysis.mealPlan?.message || 'Failed to generate meal plan. Please try again.'
        });
      }
    } catch (analysisError) {
      console.error('🍽️ [Generate Meal Plan] Analysis error:', analysisError);
      return res.status(500).json({
        success: false,
        message: `Failed to generate meal plan: ${analysisError.message}`
      });
    }
  } catch (error) {
    console.error('🍽️ [Generate Meal Plan] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate meal plan',
      error: error.message
    });
  }
});

// Debug endpoint to check event metadata
app.get('/api/debug/event/:eventId', async (req, res) => {
  try {
    const { eventId: rawEventId } = req.params;
    const eventId = decodeURIComponent(rawEventId);
    const tokens = req.session?.tokens;

    if (!tokens?.access_token) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated with Google Calendar'
      });
    }

    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const event = await calendar.events.get({
      calendarId: 'primary',
      eventId: eventId
    });

    res.json({
      success: true,
      eventId: eventId,
      summary: event.data.summary,
      extendedProperties: event.data.extendedProperties || null,
      metadata: {
        isAnalyzed: event.data.extendedProperties?.private?.isAnalyzed,
        analyzedAt: event.data.extendedProperties?.private?.analyzedAt,
        tasksCount: event.data.extendedProperties?.private?.tasksCount,
        isAIGenerated: event.data.extendedProperties?.private?.isAIGenerated
      }
    });
  } catch (error) {
    console.error('Error fetching event metadata:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch event metadata',
      error: error.message
    });
  }
});

// Delete event endpoint
app.delete('/api/calendar/events/:eventId', async (req, res) => {
  try {
    const { eventId: rawEventId } = req.params;
    const eventId = decodeURIComponent(rawEventId);
    const tokens = req.session?.tokens;

    if (!eventId) {
      return res.status(400).json({
        success: false,
        message: 'Event ID is required'
      });
    }

    let deletedFromGoogle = false;

    // If Google Calendar tokens provided, delete from Google Calendar
    if (tokens && tokens.access_token) {
      try {
        const { google } = require('googleapis');
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials(tokens);
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

        // Check if event exists in Google Calendar
        try {
          await calendar.events.get({
            calendarId: 'primary',
            eventId: eventId
          });

          // Event exists, delete it
          await calendar.events.delete({
            calendarId: 'primary',
            eventId: eventId
          });

          deletedFromGoogle = true;
          console.log(`✅ Deleted event from Google Calendar: ${eventId}`);
        } catch (getError) {
          // Event not found in Google Calendar, continue to check mock events
          console.log(`ℹ️ Event not found in Google Calendar, checking mock events: ${eventId}`);
        }
      } catch (googleError) {
        console.error('❌ Error deleting from Google Calendar:', googleError.message);
        // Continue to try deleting from mock events
      }
    }

    // Delete from mock events (either as fallback or primary)
    const deletedEvent = eventsStore.deleteEvent(eventId);
    
    // Also check and remove from mockCalendarEvents array
    const mockIndex = mockCalendarEvents.findIndex(e => e.id === eventId || e.eventId === eventId);
    if (mockIndex !== -1) {
      mockCalendarEvents.splice(mockIndex, 1);
      console.log(`🗑️ Deleted event from mock calendar: ${eventId}`);
    }

    if (deletedFromGoogle || deletedEvent || mockIndex !== -1) {
      res.json({
        success: true,
        message: 'Event deleted successfully',
        deletedFromGoogle: deletedFromGoogle
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete event',
      error: error.message
    });
  }
});

// Check event analysis status
app.get('/api/event-status/:eventId', (req, res) => {
  try {
    const { eventId } = req.params;
    
    if (!eventId) {
      return res.status(400).json({
        success: false,
        message: 'Event ID is required'
      });
    }

    // Check if event is analyzed from event data or Google Calendar metadata
    let eventToCheck;
    if (req.body.event) {
      eventToCheck = req.body.event;
    } else {
      eventToCheck = mockCalendarEvents.find(e => e.id === eventId);
    }
    
    const isAnalyzed = eventToCheck?.isAnalyzed || 
                       eventToCheck?.extendedProperties?.private?.isAnalyzed === 'true';
    
    res.json({
      success: true,
      eventId: eventId,
      isAnalyzed: isAnalyzed
    });
  } catch (error) {
    console.error('Error checking event status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check event status',
      error: error.message
    });
  }
});

// Add selected AI tasks as calendar events
app.post('/api/add-ai-tasks', async (req, res) => {
  try {
    const { selectedTasks, originalEventId } = req.body;
    
    if (!selectedTasks || !Array.isArray(selectedTasks) || selectedTasks.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Selected tasks array is required'
      });
    }

    if (!originalEventId) {
      return res.status(400).json({
        success: false,
        message: 'Original event ID is required'
      });
    }

    const addedEvents = [];
    const tokens = req.session?.tokens;
    let createdInGoogle = false;

    // If user has Google Calendar tokens, create events in Google Calendar
    if (tokens && tokens.access_token) {
      try {
        const { google } = require('googleapis');
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials(tokens);

        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';

        // Fetch original event details to get the title
        let originalEventTitle = 'the event';
        try {
          const originalEvent = await calendar.events.get({
            calendarId: 'primary',
            eventId: originalEventId
          });
          originalEventTitle = originalEvent.data.summary || 'the event';
        } catch (err) {
          console.error('Could not fetch original event title:', err.message);
        }

        for (const task of selectedTasks) {
          const startDate = new Date(task.suggestedDate);
          const duration = 60; // Default 1 hour
          const endDate = new Date(startDate.getTime() + duration * 60000);

          const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
          };

          // Ensure we have a valid task title
          const taskTitle = task.task || task.description?.split('.')[0] || task.description?.split(',')[0] || 'Preparation Task';
          
          const googleEvent = {
            summary: `📋 ${taskTitle}`,
            description: `AI-generated preparation task for "${originalEventTitle}".\n\n${task.description || ''}\n\nEstimated time: ${task.estimatedTime}\nPriority: ${task.priority}\nCategory: ${task.category}`,
            start: {
              dateTime: formatDateTime(startDate),
              timeZone: timeZone
            },
            end: {
              dateTime: formatDateTime(endDate),
              timeZone: timeZone
            },
            extendedProperties: {
              private: {
                isAIGenerated: 'true',
                originalEventId: originalEventId,
                originalEventTitle: originalEventTitle,
                priority: task.priority,
                category: task.category,
                estimatedTime: task.estimatedTime
              }
            }
          };

          const createdEvent = await calendar.events.insert({
            calendarId: 'primary',
            resource: googleEvent
          });

          addedEvents.push({
            id: createdEvent.data.id,
            title: `📋 ${taskTitle}`,
            type: 'ai-preparation',
            date: createdEvent.data.start.dateTime,
            endDate: createdEvent.data.end.dateTime,
            description: googleEvent.description,
            location: null,
            isAnalyzed: true,
            isAIGenerated: true,
            source: 'google',
            originalEventId: originalEventId,
            originalEventTitle: originalEventTitle,
            priority: task.priority,
            category: task.category,
            estimatedTime: task.estimatedTime
          });
        }

        createdInGoogle = true;
        console.log(`✅ Created ${addedEvents.length} AI tasks in Google Calendar`);

        // Mark the original event as analyzed now that tasks have been added
        try {
          console.log(`🔍 [Mark Analyzed] Attempting to mark event as analyzed:`, {
            originalEventId,
            eventIdLength: originalEventId?.length,
            hasSpecialChars: /[_:]/.test(originalEventId || '')
          });

          // First, get the current event to check existing tasksCount
          let currentTasksCount = 0;
          let originalEventExists = false;
          try {
            const currentEvent = await calendar.events.get({
              calendarId: 'primary',
              eventId: originalEventId
            });
            originalEventExists = true;
            const existingCount = currentEvent.data.extendedProperties?.private?.tasksCount;
            currentTasksCount = existingCount ? parseInt(existingCount, 10) : 0;
            console.log(`✅ [Mark Analyzed] Successfully fetched original event: "${currentEvent.data.summary}"`);
          } catch (getError) {
            console.error('❌ [Mark Analyzed] Could not get current event for tasksCount:', {
              error: getError.message,
              code: getError.code,
              eventId: originalEventId
            });
          }

          if (!originalEventExists) {
            console.error('❌ [Mark Analyzed] Cannot mark event as analyzed - original event not found in Google Calendar');
            throw new Error(`Original event ${originalEventId} not found in Google Calendar`);
          }

          const newTasksCount = currentTasksCount + selectedTasks.length;
          console.log(`📊 [Mark Analyzed] Updating event ${originalEventId}:`, {
            previousTasksCount: currentTasksCount,
            newTasksScheduled: selectedTasks.length,
            totalTasksCount: newTasksCount
          });

          const patchResult = await calendar.events.patch({
            calendarId: 'primary',
            eventId: originalEventId,
            resource: {
              extendedProperties: {
                private: {
                  isAnalyzed: 'true',
                  analyzedAt: new Date().toISOString(),
                  tasksCount: newTasksCount.toString()
                }
              }
            }
          });
          
          console.log(`✅ [Mark Analyzed] Successfully marked event as analyzed:`, {
            eventId: originalEventId,
            eventTitle: patchResult.data.summary,
            totalTasks: newTasksCount,
            timestamp: new Date().toISOString()
          });
        } catch (patchError) {
          console.error('❌ [Mark Analyzed] Failed to mark original event as analyzed:', {
            error: patchError.message,
            code: patchError.code,
            eventId: originalEventId,
            stack: patchError.stack
          });
        }

      } catch (googleError) {
        console.error('❌ Error creating tasks in Google Calendar:', googleError.message);
        // Fall through to create in mock events
      }
    }

    // If not created in Google Calendar, add to mock events
    if (!createdInGoogle) {
      const numericIds = mockCalendarEvents
        .map(e => parseInt(e.id, 10))
        .filter(id => !Number.isNaN(id));
      const highestId = numericIds.length > 0 ? Math.max(...numericIds) : 0;
      let nextId = highestId + 1;

    selectedTasks.forEach(task => {
        // Ensure we have a valid task title
        const taskTitle = task.task || task.description?.split('.')[0] || task.description?.split(',')[0] || 'Preparation Task';
        
        // Get original event title for mock events too
        let originalEventTitleForMock = 'the event';
        try {
          const originalEvent = mockCalendarEvents.find(e => e.id === originalEventId);
          if (originalEvent) {
            originalEventTitleForMock = originalEvent.title || 'the event';
          }
        } catch (err) {
          console.warn('Could not find original event for mock:', err.message);
        }
        
      const newEvent = {
        id: nextId.toString(),
          title: `📋 ${taskTitle}`,
        type: 'ai-preparation',
        date: task.suggestedDate,
        endDate: null,
          description: `AI-generated preparation task for "${originalEventTitleForMock}".\n\n${task.description || ''}\n\nEstimated time: ${task.estimatedTime}\nPriority: ${task.priority}\nCategory: ${task.category}`,
        location: null,
          isAnalyzed: true,
          isAIGenerated: true,
        originalEventId: originalEventId,
          originalEventTitle: originalEventTitleForMock,
        taskId: task.id,
        priority: task.priority,
        category: task.category,
        estimatedTime: task.estimatedTime
      };

      mockCalendarEvents.push(newEvent);
      addedEvents.push(newEvent);
      nextId++;
    });
    }

    if (originalEventId) {
      console.log(`✅ [TaskCache] Marking ${selectedTasks.length} tasks as completed for event:`, originalEventId);
      console.log(`📋 [TaskCache] Tasks being marked:`, selectedTasks.map(t => t.task || t.title));
      taskCache.markTasksCompleted(originalEventId, selectedTasks);
      
      const remaining = taskCache.getRemainingTasks(originalEventId) || [];
      console.log(`📋 [TaskCache] After marking, remaining tasks:`, {
        count: remaining.length,
        tasks: remaining.map(t => t.task || t.title)
      });

      const mockEvent = mockCalendarEvents.find(event => (event.id || event.eventId) === originalEventId);
      if (mockEvent) {
        mockEvent.isAnalyzed = true;
        mockEvent.analyzedAt = new Date().toISOString();
        mockEvent.linkedTaskCount = (mockEvent.linkedTaskCount || 0) + selectedTasks.length;
      }
    }

    res.json({
      success: true,
      addedEvents: addedEvents,
      createdInGoogle: createdInGoogle,
      message: `Successfully added ${addedEvents.length} AI-generated preparation tasks${createdInGoogle ? ' to Google Calendar' : ''}`
    });
  } catch (error) {
    console.error('Error adding AI tasks:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add AI tasks',
      error: error.message
    });
  }
});

// Get linked AI-generated tasks for an event
app.post('/api/get-linked-tasks', async (req, res) => {
  try {
    const { eventId } = req.body;

    if (!eventId) {
      return res.status(400).json({
        success: false,
        message: 'Event ID is required'
      });
    }

    const linkedTasks = await getLinkedTasksForEvent(eventId, req);

    res.json({
      success: true,
      linkedTasks: linkedTasks,
      count: linkedTasks.length
    });

  } catch (error) {
    console.error('Error fetching linked tasks:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch linked tasks',
      error: error.message
    });
  }
});

app.post('/api/get-remaining-tasks', (req, res) => {
  try {
    const { eventId } = req.body;

    if (!eventId) {
      return res.status(400).json({
        success: false,
        message: 'Event ID is required'
      });
    }

    const remainingTasks = taskCache.getRemainingTasks(eventId) || [];
    console.log(`📋 [TaskCache] Get remaining tasks for ${eventId}:`, {
      count: remainingTasks.length,
      tasks: remainingTasks.map(t => t.task || t.title)
    });

    res.json({
      success: true,
      tasks: remainingTasks,
      count: remainingTasks.length
    });
  } catch (error) {
    console.error('Error fetching remaining tasks:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch remaining tasks',
      error: error.message
    });
  }
});

// Get event title by ID (for displaying original event reference)
app.post('/api/get-event-title', async (req, res) => {
  try {
    const { eventId } = req.body;
    const tokens = req.session?.tokens;

    if (!eventId) {
      return res.status(400).json({
        success: false,
        message: 'Event ID is required'
      });
    }

    // Try to fetch from Google Calendar if user has tokens
    if (tokens && tokens.access_token) {
      try {
        const { google } = require('googleapis');
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials(tokens);

        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

        const event = await calendar.events.get({
          calendarId: 'primary',
          eventId: eventId
        });

        return res.json({
          success: true,
          title: event.data.summary || 'Untitled Event'
        });
      } catch (googleError) {
        console.error('Error fetching event title from Google Calendar:', googleError.message);
      }
    }

    // Fallback to mock events if not found in Google Calendar
    const mockEvent = mockCalendarEvents.find(e => e.id === eventId);
    if (mockEvent) {
      return res.json({
        success: true,
        title: mockEvent.title
      });
    }

    res.json({
      success: false,
      message: 'Event not found'
    });

  } catch (error) {
    console.error('Error fetching event title:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch event title',
      error: error.message
    });
  }
});

// Get weather for an event
app.post('/api/get-weather', async (req, res) => {
  try {
    const { location, eventDate, eventType, eventTitle } = req.body;

    console.log('🌤️ Weather API called:', { location, eventDate, eventType, eventTitle });

    if (!location || !eventDate) {
      return res.status(400).json({
        success: false,
        message: 'Location and event date are required'
      });
    }

    const weatherData = await weatherService.getWeatherForEvent(location, eventDate);

    console.log('🌤️ Weather service returned:', weatherData);

    if (!weatherData) {
      console.log('🌤️ No weather data available for this event');
      return res.json({
        success: true,
        weather: null,
        message: 'Weather data not available for this event'
      });
    }

    const suggestions = weatherService.generateWeatherSuggestions(
      weatherData,
      eventType,
      eventTitle
    );

    res.json({
      success: true,
      weather: {
        ...weatherData,
        suggestions
      }
    });

  } catch (error) {
    console.error('Error fetching weather:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch weather data',
      error: error.message
    });
  }
});

// Uber service routes
app.use('/api/uber', uberRoutes);
app.use('/api/wishlist', wishlistRoutes);

// Initialize events store with mockCalendarEvents
eventsStore.initialize(mockCalendarEvents);

// Google Calendar routes
app.use('/api/google-calendar', googleCalendarRoutes);

// Voice assistant routes
app.use('/api/voice', voiceRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Calendar events: http://localhost:${PORT}/api/calendar/events`);
});
