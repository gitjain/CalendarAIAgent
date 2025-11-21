import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import './VoiceAssistant.css';

const VoiceAssistant = ({ onEventAdded, userInfo, existingEvents, existingWishlistItems = [], onClose }) => {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [status, setStatus] = useState('idle'); // idle, listening, processing, speaking
  const [conflictData, setConflictData] = useState(null);
  const [alternatives, setAlternatives] = useState([]);
  const [pendingEvent, setPendingEvent] = useState(null);
  
  // Conversation state for follow-up questions
  const [conversationHistory, setConversationHistory] = useState([]);
  const [followUpCount, setFollowUpCount] = useState(0);
  const [isInFollowUpLoop, setIsInFollowUpLoop] = useState(false);

  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioChunksRef = useRef([]);
  const synthesisRef = useRef(null);
  const autoListenTimeoutRef = useRef(null);
  const autoStopTimeoutRef = useRef(null);
  const conversationIdRef = useRef(null);

  const updateConversationId = useCallback((nextId) => {
    const normalizedId = nextId || null;
    conversationIdRef.current = normalizedId;
  }, []);

  const clearConversation = useCallback(async () => {
    if (!conversationIdRef.current) {
      updateConversationId(null);
      return;
    }

    try {
      await axios.post('/api/voice/conversation/clear', {
        conversationId: conversationIdRef.current
      });
    } catch (error) {
      console.error('Error clearing voice conversation:', error);
    } finally {
      updateConversationId(null);
    }
  }, [updateConversationId]);

  const endSession = useCallback(async () => {
    if (!conversationIdRef.current) {
      updateConversationId(null);
      return;
    }

    try {
      console.log('🔚 [Voice] Ending session:', conversationIdRef.current);
      await axios.post('/api/voice/end-session', {
        conversationId: conversationIdRef.current
      });
    } catch (error) {
      console.error('Error ending voice session:', error);
    } finally {
      updateConversationId(null);
    }
  }, [updateConversationId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (autoListenTimeoutRef.current) {
        clearTimeout(autoListenTimeoutRef.current);
      }

      if (autoStopTimeoutRef.current) {
        clearTimeout(autoStopTimeoutRef.current);
      }
      if (autoStopTimeoutRef.current) {
        clearTimeout(autoStopTimeoutRef.current);
      }

      clearConversation();
    };
  }, [clearConversation]);

  // Initialize Speech Synthesis
  useEffect(() => {
    if ('speechSynthesis' in window) {
      synthesisRef.current = window.speechSynthesis;
    }
  }, []);

  const speak = useCallback((text, callback) => {
    if (!synthesisRef.current) {
      if (callback) callback();
      return;
    }

    // Cancel any ongoing speech
    synthesisRef.current.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onstart = () => {
      setStatus('speaking');
    };

    utterance.onend = () => {
      setStatus('idle');
      if (callback) {
        callback();
      }
    };

    utterance.onerror = (error) => {
      console.error('Speech synthesis error:', error);
      setStatus('idle');
      if (callback) {
        callback();
      }
    };

    synthesisRef.current.speak(utterance);
  }, []);

  const blobToBase64 = (blob) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result === 'string') {
          const base64Data = result.split(',')[1];
          resolve(base64Data);
        } else {
          reject(new Error('Failed to read audio data'));
        }
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read audio data'));
      reader.readAsDataURL(blob);
    });
  };

  const transcribeAudio = async (audioBlob) => {
    try {
      setStatus('processing');

      if (!audioBlob || audioBlob.size === 0) {
        const message = 'I did not capture any sound. Could you try speaking again?';
        setResponse(message);
        speak(message);
        return;
      }

      const base64Audio = await blobToBase64(audioBlob);
      const transcriptionResponse = await axios.post('/api/voice/transcribe', {
        audio: base64Audio,
        mimeType: audioBlob.type || 'audio/webm'
      });

      if (!transcriptionResponse.data.success) {
        throw new Error(transcriptionResponse.data.error || 'Transcription failed');
      }

      const transcriptText = (transcriptionResponse.data.transcript || '').trim();

      if (!transcriptText) {
        const message = 'I had trouble hearing that. Please try speaking again.';
        setResponse(message);
        speak(message, () => {
          if (isInFollowUpLoop) {
            autoListenTimeoutRef.current = setTimeout(() => {
              startListening(true);
            }, 500);
          }
        });
        setStatus('idle');
        return;
      }

      setTranscript(transcriptText);
      await handleVoiceInput(transcriptText);
    } catch (error) {
      console.error('Error transcribing audio:', error);
      const errorMessage = 'Sorry, I ran into an issue understanding that. Please try again.';
      setResponse(errorMessage);
      speak(errorMessage);
      setStatus('idle');
    }
  };

  const startListening = async (preserveContext = false) => {
    try {
      if (status === 'speaking') {
        return;
      }

      if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
        const message = 'Your browser does not support voice capture. Please try a different browser.';
        setResponse(message);
        speak(message);
        return;
      }

      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        return;
      }

      if (autoListenTimeoutRef.current) {
        clearTimeout(autoListenTimeoutRef.current);
      }

      if (!preserveContext) {
        await clearConversation();
        setConversationHistory([]);
        setFollowUpCount(0);
        setIsInFollowUpLoop(false);
        setResponse('');
      }

      setTranscript('');
      setConflictData(null);
      setAlternatives([]);
      setPendingEvent(null);

      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = mediaStream;

      const recorder = new MediaRecorder(mediaStream);
      audioChunksRef.current = [];

      recorder.onstart = () => {
        setIsListening(true);
        setStatus('listening');
        autoStopTimeoutRef.current = setTimeout(() => {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
          }
        }, 12000);
      };

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.error('MediaRecorder error:', event.error || event.name);
        setIsListening(false);
        setStatus('idle');
        setResponse('There was an issue capturing audio. Please try again.');
      };

      recorder.onstop = async () => {
        setIsListening(false);

        if (autoStopTimeoutRef.current) {
          clearTimeout(autoStopTimeoutRef.current);
        }

        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach(track => track.stop());
          mediaStreamRef.current = null;
        }

        const chunks = audioChunksRef.current || [];
        audioChunksRef.current = [];

        if (!chunks.length) {
          if (!preserveContext) {
            setStatus('idle');
          }
          return;
        }

        const mimeType = recorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(chunks, { type: mimeType });
        await transcribeAudio(audioBlob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
    } catch (error) {
      console.error('Microphone access error:', error);
      const message = 'I need microphone access to listen. Please enable it in your browser settings.';
      setResponse(message);
      speak(message);
      setStatus('idle');
      setIsListening(false);
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
      }
    }
  };

  const stopListening = ({ preserveContext = false } = {}) => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    // Clear all timeouts to prevent auto-restart
    if (autoStopTimeoutRef.current) {
      clearTimeout(autoStopTimeoutRef.current);
      autoStopTimeoutRef.current = null;
    }

    if (autoListenTimeoutRef.current) {
      clearTimeout(autoListenTimeoutRef.current);
      autoListenTimeoutRef.current = null;
    }

    // Stop any ongoing speech synthesis
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    if (!preserveContext) {
      setIsInFollowUpLoop(false);
      setFollowUpCount(0);
      setConversationHistory([]);
    }

    // Reset status to idle
    setStatus('idle');
    setIsListening(false);
  };

  const handleVoiceInput = async (transcriptText) => {
    setStatus('processing');
    setTranscript(transcriptText);

    try {
      // Parse intent with conversation context
      const intentResponse = await axios.post('/api/voice/process', {
        transcript: transcriptText,
        context: {
          currentDate: new Date().toISOString().split('T')[0],
          conversationHistory: conversationHistory,
          followUpCount: followUpCount,
          conversationId: conversationIdRef.current
        }
      });

      if (!intentResponse.data.success) {
        throw new Error(intentResponse.data.error || 'Failed to process voice input');
      }

      const { 
        intent, 
        eventDetails, 
        followUpQuestion, 
        readyToProcess, 
        abort, 
        abortMessage,
        conversationHistory: updatedHistory,
        conversationId: returnedConversationId
      } = intentResponse.data;

      if (returnedConversationId !== undefined) {
        updateConversationId(returnedConversationId);
      }

      // Update conversation history
      if (updatedHistory) {
        setConversationHistory(updatedHistory);
      }

      // Handle abort scenario (max follow-ups reached)
      if (abort && abortMessage) {
        setResponse(abortMessage);
        speak(abortMessage, () => {
          setIsInFollowUpLoop(false);
          setFollowUpCount(0);
          setConversationHistory([]);
          setStatus('idle');
        });
        await clearConversation();
        return;
      }

      // Handle follow-up question
      if (intent === 'needs_clarification' && followUpQuestion && followUpCount < 5) {
        setResponse(followUpQuestion);
        setFollowUpCount(prev => prev + 1);
        setIsInFollowUpLoop(true);
        
        // Speak the question, then auto-start listening
        speak(followUpQuestion, () => {
          // Auto-start listening after speaking
          autoListenTimeoutRef.current = setTimeout(() => {
            startListening(true);
          }, 500);
        });
        return;
      }

      // Handle ready to process intents
      if (readyToProcess) {
        if (intent === 'add_event') {
          await handleAddEvent(eventDetails);
        } else if (intent === 'delete_event') {
          await handleDeleteEvent(eventDetails);
        } else if (intent === 'add_to_wishlist') {
          await handleAddToWishlist(eventDetails);
        } else if (intent === 'update_wishlist') {
          await handleUpdateWishlist(intentResponse.data);
        } else if (intent === 'delete_wishlist') {
          await handleDeleteWishlist(intentResponse.data);
        } else {
          const responseText = await generateResponse({
            type: 'info',
            message: `I understand you want to ${intent.replace('_', ' ')}, but I can currently help with adding or deleting events, or managing wishlist items.`
          });
          setResponse(responseText);
          speak(responseText, () => {
            setStatus('idle');
          });
        }
        // Reset conversation state after processing
        setIsInFollowUpLoop(false);
        setFollowUpCount(0);
        setConversationHistory([]);
      }
    } catch (error) {
      console.error('Error handling voice input:', error);
      const errorMessage = 'Sorry, I encountered an error. Please try again.';
      setResponse(errorMessage);
      speak(errorMessage);
      setStatus('idle');
      setIsInFollowUpLoop(false);
    }
  };

  const handleAddEvent = async (eventDetails) => {
    // Store pending event
    setPendingEvent(eventDetails);

    try {
      // Check for conflicts
      const conflictResponse = await axios.post('/api/voice/check-conflict', {
        eventDetails,
        existingEvents: existingEvents || [],
        tokens: userInfo?.tokens || null,
        conversationId: conversationIdRef.current
      });

      if (!conflictResponse.data.success) {
        throw new Error(conflictResponse.data.error || 'Failed to check conflicts');
      }

      if (conflictResponse.data.conversationId !== undefined) {
        updateConversationId(conflictResponse.data.conversationId);
      }

      const { hasConflict, conflictInfo, alternatives: altTimes, response: conflictResponseText, allowOverride } = conflictResponse.data;

      if (hasConflict) {
        // Store conflict data for user decision
        setConflictData({
          conflictInfo,
          allowOverride
        });
        setAlternatives(altTimes || []);
        setResponse(conflictResponseText);
        speak(conflictResponseText);
      } else {
        // No conflict, create event directly
        await createEvent(eventDetails, false);
      }
    } catch (error) {
      console.error('Error checking conflict:', error);
      const errorMessage = 'Sorry, I couldn\'t check for conflicts. Please try again.';
      setResponse(errorMessage);
      speak(errorMessage);
      setStatus('idle');
    }
  };

  const handleAddToWishlist = async (eventDetails) => {
    try {
      const response = await axios.post('/api/voice/add-to-wishlist', {
        eventDetails
      });

      if (response.data.success) {
        const successMsg = response.data.response || `Added "${eventDetails.title}" to your wishlist! I'll suggest it when you have free time.`;
        setResponse(successMsg);
        speak(successMsg);
        setStatus('idle');
        
        // Notify parent if callback exists (for refresh)
        if (onEventAdded) {
          onEventAdded(null); // Signal refresh
        }
      } else {
        throw new Error(response.data.error || 'Failed to add to wishlist');
      }
    } catch (error) {
      console.error('Error adding to wishlist:', error);
      const errorMessage = error.response?.data?.error || 'Sorry, I couldn\'t add that to your wishlist. Please try again.';
      setResponse(errorMessage);
      speak(errorMessage);
      setStatus('idle');
    }
  };

  const handleUpdateWishlist = async (intentData) => {
    try {
      const { wishlistItemMatch, wishlistItemId, updates, eventDetails } = intentData;
      
      const response = await axios.post('/api/voice/update-wishlist', {
        wishlistItemId,
        wishlistItemMatch,
        updates: updates || {
          title: eventDetails?.title,
          location: eventDetails?.location,
          description: eventDetails?.description
        }
      });

      if (response.data.success) {
        const successMsg = response.data.response || `Updated wishlist item "${response.data.item?.title}" successfully.`;
        setResponse(successMsg);
        speak(successMsg);
        setStatus('idle');
        
        // Notify parent if callback exists (for refresh)
        if (onEventAdded) {
          onEventAdded(null); // Signal refresh
        }
      } else {
        throw new Error(response.data.error || 'Failed to update wishlist item');
      }
    } catch (error) {
      console.error('Error updating wishlist:', error);
      const errorMessage = error.response?.data?.error || 'Sorry, I couldn\'t find that wishlist item to update. Please try again.';
      setResponse(errorMessage);
      speak(errorMessage);
      setStatus('idle');
    }
  };

  const handleDeleteWishlist = async (intentData) => {
    try {
      const { wishlistItemMatch, wishlistItemId } = intentData;
      
      const response = await axios.post('/api/voice/delete-wishlist', {
        wishlistItemId,
        wishlistItemMatch
      });

      if (response.data.success) {
        const successMsg = response.data.response || `Removed "${response.data.item?.title}" from your wishlist.`;
        setResponse(successMsg);
        speak(successMsg);
        setStatus('idle');
        
        // Notify parent if callback exists (for refresh)
        if (onEventAdded) {
          onEventAdded(null); // Signal refresh
        }
      } else {
        throw new Error(response.data.error || 'Failed to delete wishlist item');
      }
    } catch (error) {
      console.error('Error deleting wishlist item:', error);
      const errorMessage = error.response?.data?.error || 'Sorry, I couldn\'t find that wishlist item to delete. Please try again.';
      setResponse(errorMessage);
      speak(errorMessage);
      setStatus('idle');
    }
  };

  const handleDeleteEvent = async (eventDetails) => {
    try {
      // Find event to delete
      if (!eventDetails.title && !eventDetails.date && !eventDetails.time) {
        throw new Error('Not enough information to identify event for deletion');
      }

      // Find matching event in existing events
      const matchingEvent = existingEvents.find(event => {
        const eventDate = new Date(event.date).toISOString().split('T')[0];
        const eventTime = event.time || new Date(event.date).toTimeString().slice(0, 5);
        
        const titleMatch = eventDetails.title ? 
          event.title.toLowerCase().includes(eventDetails.title.toLowerCase()) : true;
        const dateMatch = eventDetails.date ? 
          eventDate === eventDetails.date : true;
        const timeMatch = eventDetails.time ? 
          eventTime === eventDetails.time : true;

        return titleMatch && dateMatch && timeMatch;
      });

      if (!matchingEvent) {
        const errorMsg = "I couldn't find a matching event to delete. Could you provide more details?";
        setResponse(errorMsg);
        speak(errorMsg, () => {
          setStatus('idle');
        });
        return;
      }

      // Delete the event
      const eventId = matchingEvent.id || matchingEvent.eventId;
      const deleteResponse = await axios.delete(`/api/calendar/events/${eventId}`, {
        withCredentials: true
      });

      if (deleteResponse.data.success) {
        const successMsg = `I've deleted "${matchingEvent.title}" from your calendar.`;
        setResponse(successMsg);
        speak(successMsg);
        
        // Refresh events (notify parent to refresh)
        if (onEventAdded) {
          onEventAdded(null); // Parent will handle null as refresh signal
        }
        // Reset conversation state after successful deletion
        setIsInFollowUpLoop(false);
        setFollowUpCount(0);
        setConversationHistory([]);
        setStatus('idle');
      } else {
        throw new Error('Failed to delete event');
      }
    } catch (error) {
      console.error('Error deleting event:', error);
      const errorMessage = error.response?.data?.error || 'Sorry, I couldn\'t delete that event. Please try again.';
      setResponse(errorMessage);
      speak(errorMessage);
      setStatus('idle');
    }
  };

  const handleUserChoice = async (choice) => {
    if (!pendingEvent) return;

    if (choice.type === 'alternative') {
      // User chose an alternative time
      const updatedEvent = {
        ...pendingEvent,
        date: choice.date,
        time: choice.time
      };
      await createEvent(updatedEvent, false);
    } else if (choice.type === 'override') {
      // User chose to double book
      await createEvent(pendingEvent, true);
    } else if (choice.type === 'cancel') {
      // User cancelled
      await clearConversation();
      setPendingEvent(null);
      setConflictData(null);
      setAlternatives([]);
      setResponse('');
      const cancelMessage = 'Okay, I\'ve cancelled that. What else can I help you with?';
      speak(cancelMessage);
      setResponse(cancelMessage);
    }
  };

  const createEvent = async (eventDetails, override) => {
    try {
      const createResponse = await axios.post('/api/voice/create-event', {
        eventDetails,
        tokens: userInfo?.tokens || null,
        override,
        conversationId: conversationIdRef.current
      });

      if (!createResponse.data.success) {
        throw new Error(createResponse.data.error || 'Failed to create event');
      }

      const { event, response: successResponse, createdInGoogle } = createResponse.data;
      
      // Clear pending state
      setPendingEvent(null);
      setConflictData(null);
      setAlternatives([]);
      
      // Notify parent component (this triggers event refresh)
      if (onEventAdded) {
        onEventAdded(event);
      }

      // Speak success message
      let finalMessage = successResponse;
      if (createdInGoogle) {
        finalMessage = `I've added ${event.title} to your Google Calendar for ${new Date(event.date).toLocaleDateString()} at ${event.time || new Date(event.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
      }
      setResponse(finalMessage);
      speak(finalMessage);
      setStatus('idle');

      if (createResponse.data.conversationCleared) {
        updateConversationId(null);
      }
    } catch (error) {
      console.error('Error creating event:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Sorry, I couldn\'t create that event.';
      let errorMessage = `Sorry, ${errorMsg.toLowerCase()}`;
      
      // Provide more helpful error messages
      if (errorMsg.includes('authentication') || errorMsg.includes('sign in')) {
        errorMessage = 'Please sign in to Google Calendar to add events.';
      } else if (errorMsg.includes('Invalid date') || errorMsg.includes('format')) {
        errorMessage = 'I had trouble understanding the date or time. Please try saying it differently, like "November 1st at 7:30 PM".';
      }
      
      setResponse(errorMessage);
      speak(errorMessage);
      setStatus('idle');
    }
  };

  const generateResponse = async (responseData) => {
    try {
      const response = await axios.post('/api/voice/generate-response', {
        responseData
      });
      return response.data.response;
    } catch (error) {
      console.error('Error generating response:', error);
      return 'Got it!';
    }
  };

  const formatTime = (timeStr) => {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
  };

  const formatDate = (dateStr) => {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <div className="voice-assistant">
      <div className="voice-assistant-header">
        <h3>🎤 Voice Assistant</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div className="voice-status">
            <span className={`status-indicator ${status}`}></span>
            <span className="status-text">
              {status === 'idle' && 'Ready'}
              {status === 'listening' && 'Listening...'}
              {status === 'processing' && 'Processing...'}
              {status === 'speaking' && 'Speaking...'}
            </span>
            {isInFollowUpLoop && (
              <span className="follow-up-indicator">(Question {followUpCount}/5)</span>
            )}
          </div>
          {onClose && (
            <button
              onClick={() => {
                endSession();
                onClose();
              }}
              className="voice-close-btn"
              title="Close Voice Assistant"
              style={{
                background: 'none',
                border: 'none',
                fontSize: '1.5rem',
                cursor: 'pointer',
                padding: '0.25rem 0.5rem',
                color: '#6b7280',
                lineHeight: 1
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="voice-controls">
        <button
          className={`voice-button ${isListening ? 'listening' : ''}`}
          onClick={isListening ? stopListening : startListening}
          disabled={status === 'processing' || status === 'speaking'}
        >
          {isListening ? '🛑 Stop' : '🎤 Start Speaking'}
        </button>
      </div>

      {transcript && (
        <div className="voice-transcript">
          <strong>🎤 You said:</strong>
          <p className="transcript-text">{transcript}</p>
        </div>
      )}

      {response && (
        <div className="voice-response">
          <strong>Assistant:</strong>
          <p>{response}</p>
        </div>
      )}

      {conflictData && alternatives.length > 0 && (
        <div className="conflict-options">
          <h4>Choose an option:</h4>
          
          <div className="alternatives-list">
            {alternatives.map((alt, index) => (
              <button
                key={index}
                className="alternative-btn"
                onClick={() => handleUserChoice({
                  type: 'alternative',
                  date: alt.date,
                  time: alt.time
                })}
              >
                <span className="alternative-time">{formatTime(alt.time)}</span>
                <span className="alternative-date">{formatDate(alt.date)}</span>
              </button>
            ))}
          </div>

          {conflictData.allowOverride && (
            <button
              className="override-btn"
              onClick={() => handleUserChoice({ type: 'override' })}
            >
              📅 Double Book (Override Conflict)
            </button>
          )}

          <button
            className="cancel-btn"
            onClick={() => handleUserChoice({ type: 'cancel' })}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

export default VoiceAssistant;
