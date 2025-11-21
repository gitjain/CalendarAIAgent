import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import './EventAnalysis.css';
import UberBookingModal from './UberBookingModal';

const sessionAnalysisCache = new Map();

const extractGoogleDocUrls = (text = '') => {
  if (!text) {
    return [];
  }
  const pattern = /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/g;
  const urls = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    urls.push({
      fullUrl: match[0],
      docId: match[1]
    });
  }
  return urls;
};

const cloneAnalysis = (analysis) => {
  if (!analysis) return null;
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(analysis);
    }
  } catch (error) {
    // structuredClone not available
  }
  return JSON.parse(JSON.stringify(analysis));
};

const EventAnalysis = ({ event, onClose, onTasksAdded, onEventAnalyzed }) => {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTasks, setSelectedTasks] = useState([]);
  const [addingTasks, setAddingTasks] = useState(false);
  const [showUberModal, setShowUberModal] = useState(false);
  const [editedTasks, setEditedTasks] = useState({}); // Store edited versions of tasks
  const [editingTaskId, setEditingTaskId] = useState(null); // Track which task is being edited
  const [isAlreadyAnalyzed, setIsAlreadyAnalyzed] = useState(false);
  const [hasScheduledTasks, setHasScheduledTasks] = useState(false);
  const [showDescriptionEditor, setShowDescriptionEditor] = useState(false);
  const [editedDescription, setEditedDescription] = useState('');
  const [detectedDocUrls, setDetectedDocUrls] = useState([]);
  const [showMealPlanModal, setShowMealPlanModal] = useState(false);
  const [mealPlanPreferences, setMealPlanPreferences] = useState({
    days: 7,
    familySize: '',
    targetCalories: 2000,
    diet: '',
    exclude: ''
  });
  const [generatingMealPlan, setGeneratingMealPlan] = useState(false);
  const [pendingAnalysis, setPendingAnalysis] = useState(false); // Track if analysis is pending after meal plan prefs
  const previousEventIdRef = useRef(null);
  const eventId = event?.id || event?.eventId;
  const hydratingRef = useRef(false);
  const hasShownModalForCurrentAnalysis = useRef(false); // Track if modal was already shown for this analysis cycle

  // Client-side meal prep event detection
  const isMealPrepEvent = (event) => {
    if (!event) return false;
    const text = `${event.title || ''} ${event.description || ''} ${event.type || ''}`.toLowerCase();
    const hasPrep = text.includes('prep');
    if (!hasPrep) return false;
    const mealKeywords = ['meal', 'lunch', 'dinner', 'breakfast', 'snack'];
    return mealKeywords.some(keyword => text.includes(keyword));
  };
  function normalizeAnalysisPayload(rawAnalysis) {
    if (!rawAnalysis) return null;

    const linked = Array.isArray(rawAnalysis.linkedTasks)
      ? rawAnalysis.linkedTasks
      : [];
    const linkedIds = new Set(
      linked.map((task) => getTaskIdentifier(task)).filter(Boolean)
    );

    const remaining = Array.isArray(rawAnalysis.preparationTasks)
      ? rawAnalysis.preparationTasks.filter(
          (task) => !linkedIds.has(getTaskIdentifier(task))
        )
      : [];

    return {
      ...rawAnalysis,
      linkedTasks: linked,
      preparationTasks: remaining,
      remainingTaskCount: remaining.length,
      totalLinkedTasks: linked.length,
      remainingTasksOnly: rawAnalysis.remainingTasksOnly ?? linked.length > 0,
      allTasksScheduled: remaining.length === 0 && linked.length > 0
    };
  }

  useEffect(() => {
    setSelectedTasks([]);
  }, [analysis]);

  useEffect(() => {
    if (!event) {
      setAnalysis(null);
      setIsAlreadyAnalyzed(false);
      setHasScheduledTasks(false);
      setError(null);
      setEditedDescription('');
      setDetectedDocUrls([]);
      setShowDescriptionEditor(false);
      previousEventIdRef.current = null;
      return;
    }

    const newEventId = eventId;
    const cachedEntry = newEventId ? sessionAnalysisCache.get(newEventId) : null;

    setError(null);
    setShowMealPlanModal(false);
    hasShownModalForCurrentAnalysis.current = false; // Reset flag for new event
    setEditingTaskId(null);
    setSelectedTasks([]);
    setShowDescriptionEditor(false);

    if (cachedEntry) {
      const clonedAnalysis = cloneAnalysis(cachedEntry.analysis);
      const sanitized = normalizeAnalysisPayload(clonedAnalysis);
      sessionAnalysisCache.set(newEventId, {
        ...cachedEntry,
        analysis: cloneAnalysis(sanitized)
      });
      const isFinalized = Boolean(cachedEntry.finalized);
      setAnalysis(sanitized);
      setIsAlreadyAnalyzed(Boolean(sanitized) || isFinalized);
      setHasScheduledTasks(Boolean(cachedEntry.hasScheduledTasks || isFinalized));

      const restoredDescription = cachedEntry.descriptionOverride ?? event.description ?? '';
      setEditedDescription(restoredDescription);
      setDetectedDocUrls(extractGoogleDocUrls(restoredDescription));
    } else {
      setAnalysis(null);
      setIsAlreadyAnalyzed(false);
      setHasScheduledTasks(false);

      const initialDescription = event.description || '';
      setEditedDescription(initialDescription);
      setDetectedDocUrls(extractGoogleDocUrls(initialDescription));
    }

    previousEventIdRef.current = newEventId;
  }, [event, eventId]);

  useEffect(() => {
    console.log('🔍 [Hydration Check]', {
      eventId,
      eventTitle: event?.title,
      hasAnalysis: !!analysis,
      hasCachedAnalysis: !!sessionAnalysisCache.get(eventId || ''),
      eventIsAnalyzed: event?.isAnalyzed,
      eventLinkedTaskCount: event?.linkedTaskCount,
      eventIsAIGenerated: event?.isAIGenerated,
      hydratingRefCurrent: hydratingRef.current
    });

    const shouldHydrateFromServer =
      !analysis &&
      !sessionAnalysisCache.get(eventId || '') &&
      event &&
      (event.isAnalyzed || (event.linkedTaskCount && event.linkedTaskCount > 0)) &&
      !event.isAIGenerated &&
      eventId &&
      !hydratingRef.current;

    console.log('🔍 [Hydration Decision]', {
      shouldHydrate: shouldHydrateFromServer,
      reason: !shouldHydrateFromServer ? 
        (!analysis ? 'has analysis' : 
         !sessionAnalysisCache.get(eventId || '') ? 'has cached analysis' :
         !event ? 'no event' :
         !(event.isAnalyzed || (event.linkedTaskCount && event.linkedTaskCount > 0)) ? 'not analyzed or no linked tasks' :
         event.isAIGenerated ? 'is AI generated' :
         !eventId ? 'no eventId' :
         hydratingRef.current ? 'already hydrating' : 'unknown') : 'will hydrate'
    });

    if (!shouldHydrateFromServer) {
      return;
    }

    hydratingRef.current = true;
    console.log('🚀 [Starting Hydration] for event:', eventId);

    const hydrate = async () => {
      try {
        setLoading(true);
        console.log('📡 [Fetching] linked and remaining tasks for:', eventId);
        const [linkedRes, remainingRes] = await Promise.all([
          axios.post('/api/get-linked-tasks', { eventId }),
          axios.post('/api/get-remaining-tasks', { eventId })
        ]);

        const linked = Array.isArray(linkedRes.data?.linkedTasks)
          ? linkedRes.data.linkedTasks
          : [];
        const remaining = Array.isArray(remainingRes.data?.tasks)
          ? remainingRes.data.tasks
          : [];
        
        console.log('✅ [Hydration Data]', {
          linkedCount: linked.length,
          remainingCount: remaining.length,
          linked: linked.map(t => ({ title: t.title, date: t.date })),
          remaining: remaining.map(t => ({ task: t.task, category: t.category }))
        });

        // If both linked and remaining are 0, the tasks were likely deleted from Google Calendar
        // Don't mark as analyzed - let user regenerate
        if (linked.length === 0 && remaining.length === 0) {
          console.log('⚠️  [Hydration] No tasks found - tasks may have been deleted. Clearing state.');
          sessionAnalysisCache.delete(eventId);
          setAnalysis(null);
          setIsAlreadyAnalyzed(false);
          setHasScheduledTasks(false);
          setLoading(false);
          hydratingRef.current = false;
          return;
        }

        const hydratedAnalysis = normalizeAnalysisPayload({
          eventSummary: `Remaining checklist items for ${event.title || 'this event'}`,
          preparationTasks: remaining,
          timeline: { timeframe: [] },
          tips: [],
          estimatedPrepTime:
            remaining.length > 0 ? `${remaining.length} task${remaining.length > 1 ? 's' : ''} remaining` : '0 minutes remaining',
          requiresMealPlanPreferences: false,
          remainingTasksOnly: true,
          allTasksScheduled: remaining.length === 0,
          linkedTasks: linked,
          totalLinkedTasks: linked.length,
          remainingTaskCount: remaining.length
        });

        sessionAnalysisCache.set(eventId, {
          analysis: cloneAnalysis(hydratedAnalysis),
          hasScheduledTasks: linked.length > 0,
          descriptionOverride: event.description || '',
          finalized: linked.length > 0
        });

        setAnalysis(hydratedAnalysis);
        setIsAlreadyAnalyzed(true);
        setHasScheduledTasks(linked.length > 0);
        setEditedDescription(event.description || '');
        setDetectedDocUrls(extractGoogleDocUrls(event.description || ''));
        setEditedTasks({});
      } catch (err) {
        console.error('Failed to hydrate analyzed event:', err);
        setError('Unable to load existing checklist. Please try again.');
      } finally {
        setLoading(false);
        hydratingRef.current = false;
      }
    };

    hydrate();
  }, [event, eventId]);

  const preparationTasks = Array.isArray(analysis?.preparationTasks)
    ? analysis.preparationTasks
    : [];
  const hasPreparationTasks = preparationTasks.length > 0;
  const linkedTasks = Array.isArray(analysis?.linkedTasks)
    ? analysis.linkedTasks
    : [];
  const hasLinkedTasks = linkedTasks.length > 0;

function getTaskIdentifier(task) {
  if (!task) return '';
  if (task.id) return `id:${task.id}`;
  if (task.task) return `task:${task.task.toString().trim().toLowerCase()}`;
  if (task.title) return `title:${task.title.toString().trim().toLowerCase()}`;
  const parts = [
    task.category || '',
    task.description || '',
    task.estimatedTime || ''
  ]
    .map((part) => part.toString().trim().toLowerCase())
    .join('|');
  return `fallback:${parts}`;
}

  const findTaskByIdentifier = (tasks, identifier) => {
    if (!identifier) {
      return { task: undefined, index: -1 };
    }
    for (let i = 0; i < tasks.length; i += 1) {
      if (getTaskIdentifier(tasks[i]) === identifier) {
        return { task: tasks[i], index: i };
      }
    }
    return { task: undefined, index: -1 };
  };
  const formatLinkedTaskDate = (dateStr) => {
    if (!dateStr) {
      return 'Date TBD';
    }
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) {
      return dateStr;
    }
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const addSelectedTasksToCalendar = async () => {
    if (selectedTasks.length === 0) {
      alert('Please select at least one task to add to your calendar.');
      return;
    }

    setAddingTasks(true);
    try {
      const tasksPayload = selectedTasks.map(({ __taskKey, ...rest }) => rest);
      const response = await axios.post('/api/add-ai-tasks', {
        selectedTasks: tasksPayload,
        originalEventId: event.id
      });

      const addedEvents = response.data.addedEvents || [];
      if (response.data.success) {
        setIsAlreadyAnalyzed(true);
        setHasScheduledTasks(true);
        setSelectedTasks([]);
        
        // Notify parent to refresh events and mark as analyzed
        if (onEventAnalyzed && eventId) {
          onEventAnalyzed(eventId);
        }
        onTasksAdded && onTasksAdded(addedEvents);
        
        // Instead of clearing analysis completely, update it with the new linked tasks
        // This keeps hasLinkedTasks in sync with hasScheduledTasks
        setAnalysis(prev => {
          if (!prev) return prev;
          
          const selectedIds = new Set(
            selectedTasks
              .map(task => task.__taskKey || getTaskIdentifier(task))
              .filter(Boolean)
          );
          const remainingTasks = (prev.preparationTasks || []).filter((task) => {
            const identifier = getTaskIdentifier(task);
            return !selectedIds.has(identifier);
          });
          
          const updatedLinked = [...(prev.linkedTasks || []), ...addedEvents];
          
          return normalizeAnalysisPayload({
            ...prev,
            preparationTasks: remainingTasks,
            linkedTasks: updatedLinked,
            remainingTaskCount: remainingTasks.length,
            totalLinkedTasks: updatedLinked.length,
            allTasksScheduled: remainingTasks.length === 0
          });
        });
        
        // Clear cache so next time it hydrates fresh from server
        if (eventId) {
          sessionAnalysisCache.delete(eventId);
        }
        hydratingRef.current = false; // Allow re-hydration on next open
      } else {
        setError('Failed to add tasks to calendar');
      }
    } catch (err) {
      setError('Error adding tasks to calendar. Please try again.');
      console.error('Error:', err);
    } finally {
      setAddingTasks(false);
    }
  };
  
  const analyzeEvent = useCallback(async (withMealPlanPreferences = null) => {
    if (!event || !eventId) {
      setError('Event is missing an identifier. Please refresh and try again.');
      return;
    }

    setLoading(true);
    setError(null);
    console.log('[analysis] request_start', {
      eventId,
      title: event.title,
      hasMealPlanPrefs: !!withMealPlanPreferences
    });
    
    const source = axios.CancelToken.source();
    const timeoutId = setTimeout(() => {
      source.cancel(new Error('Event analysis timed out. Please try again.'));
    }, 30000);

    try {
      const allowManualReanalyze = isAlreadyAnalyzed && !hasScheduledTasks;

      // Use edited description if available, otherwise use original
      const eventToAnalyze = {
        ...event,
        description: editedDescription || event.description || ''
      };

      if (allowManualReanalyze) {
        eventToAnalyze.isAnalyzed = false;
        if (eventToAnalyze.extendedProperties?.private) {
          eventToAnalyze.extendedProperties = {
            ...eventToAnalyze.extendedProperties,
            private: {
              ...eventToAnalyze.extendedProperties.private,
              isAnalyzed: 'false'
            }
          };
        }
      }

      // Build request payload with optional meal plan preferences
      const requestPayload = { 
        event: eventToAnalyze, 
        forceReanalyze: allowManualReanalyze 
      };

      // If meal plan preferences are provided, include them
      if (withMealPlanPreferences) {
        requestPayload.mealPlanPreferences = withMealPlanPreferences;
        requestPayload.shouldAttemptMealPlan = true;
      }
      
      const response = await axios.post(
        '/api/analyze-event',
        requestPayload,
        { cancelToken: source.token }
      );
      
      if (response.data.success) {
        const normalizedAnalysis = normalizeAnalysisPayload(response.data.analysis);
        const descriptionOverride = eventToAnalyze.description || '';
        setAnalysis(normalizedAnalysis);
        setEditedDescription(descriptionOverride);
        setDetectedDocUrls(extractGoogleDocUrls(descriptionOverride));
        sessionAnalysisCache.set(eventId, {
          analysis: cloneAnalysis(normalizedAnalysis),
          hasScheduledTasks: false,
          descriptionOverride,
          finalized: false
        });
        setHasScheduledTasks(false);
        // Don't mark as analyzed yet - only mark when user schedules tasks
        setIsAlreadyAnalyzed(false);
        console.log('[analysis] request_success', {
          eventId,
          title: event.title,
          tasksGenerated: normalizedAnalysis?.preparationTasks?.length || 0
        });

      } else {
        setError(response.data.message || 'Failed to analyze event');
      }
    } catch (err) {
      if (axios.isCancel(err)) {
        const timeoutMessage = err.message || 'Event analysis timed out. Please try again.';
        console.warn('[analysis] request_timeout', {
          eventId,
          title: event?.title,
          message: timeoutMessage
        });
        setError(timeoutMessage);
      } else if (err.response?.data?.message) {
        const errorMsg = err.response.data.message;
        setError(errorMsg);
        
        if (errorMsg.includes('already been analyzed')) {
          setIsAlreadyAnalyzed(true);
        }
        // Note: AI-generated events are now blocked at the server level
        console.error('[analysis] request_failed', {
          eventId,
          title: event?.title,
          message: errorMsg
        });
      } else {
        setError('Error analyzing event. Please try again.');
        console.error('[analysis] request_failed', {
          eventId,
          title: event?.title,
          message: err?.message
        });
      }
      console.error('Error:', err);
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }, [event, eventId, editedDescription, onEventAnalyzed, isAlreadyAnalyzed, hasScheduledTasks]);

  // Generate meal plan with user preferences
  // Handle "Generate Checklist" button click - check for meal prep events first
  const handleGenerateChecklist = () => {
    if (!isAlreadyAnalyzed && isMealPrepEvent(event)) {
      // This is a meal prep event and hasn't been analyzed yet
      // Show modal to get preferences first
      console.log('[meal-plan] Detected meal prep event, showing preferences modal');
      setPendingAnalysis(true);
      setShowMealPlanModal(true);
      hasShownModalForCurrentAnalysis.current = true; // Mark that we've shown the modal
    } else {
      // Not a meal prep event or already analyzed - proceed normally
      analyzeEvent();
    }
  };

  const handleGenerateMealPlan = async () => {
    setGeneratingMealPlan(true);
    setError(null);
    
    try {
      if (pendingAnalysis) {
        // This is the first analysis with meal plan preferences
        console.log('[meal-plan] Analyzing event with preferences:', mealPlanPreferences);
        setShowMealPlanModal(false);
        setPendingAnalysis(false);
        hasShownModalForCurrentAnalysis.current = true; // Prevent modal from showing again
        // Call analyzeEvent with preferences
        await analyzeEvent(mealPlanPreferences);
        setGeneratingMealPlan(false);
        return;
      }

      // This is a re-generation of meal plan for already analyzed event
      const response = await axios.post('/api/generate-meal-plan', {
        event: event,
        preferences: mealPlanPreferences,
        analysis: analysis // Pass current analysis to update it
      });

      if (response.data.success) {
        // Update analysis with meal plan
        const updatedAnalysis = normalizeAnalysisPayload(response.data.analysis);
        setAnalysis(updatedAnalysis);
        if (eventId) {
          const existingEntry = sessionAnalysisCache.get(eventId) || {};
          sessionAnalysisCache.set(eventId, {
            ...existingEntry,
            analysis: cloneAnalysis(updatedAnalysis),
            hasScheduledTasks: hasScheduledTasks,
            descriptionOverride: existingEntry.descriptionOverride ?? (editedDescription || event.description || ''),
            finalized: existingEntry.finalized || hasScheduledTasks
          });
        }
        setShowMealPlanModal(false);
        // Show success message
      } else {
        setError(response.data.message || 'Failed to generate meal plan');
      }
    } catch (err) {
      if (err.response?.data?.message) {
        setError(err.response.data.message);
      } else {
        setError('Error generating meal plan. Please try again.');
      }
      console.error('Error:', err);
    } finally {
      setGeneratingMealPlan(false);
    }
  };

  // Check if meal plan preferences are needed after analysis
  useEffect(() => {
    if (analysis && analysis.requiresMealPlanPreferences && !hasShownModalForCurrentAnalysis.current) {
      console.log('[meal-plan] Analysis requires preferences, showing modal');
      setShowMealPlanModal(true);
      hasShownModalForCurrentAnalysis.current = true;
    }
  }, [analysis]);

  const getPriorityColor = (priority) => {
    switch (priority.toLowerCase()) {
      case 'high': return '#ff4757';
      case 'medium': return '#ffa502';
      case 'low': return '#2ed573';
      default: return '#747d8c';
    }
  };

  const handleTaskSelection = (task, _index, isSelected) => {
    const taskKey = getTaskIdentifier(task);
    const editedVersion = editedTasks[taskKey];
    const taskToPersist = {
      ...(editedVersion || task),
      __taskKey: taskKey
    };

    if (isSelected) {
      setSelectedTasks(prev => {
        if (prev.some(t => (t.__taskKey || getTaskIdentifier(t)) === taskKey)) {
          return prev;
        }
        return [...prev, taskToPersist];
      });
    } else {
      setSelectedTasks(prev => prev.filter(t => (t.__taskKey || getTaskIdentifier(t)) !== taskKey));
    }
  };

  const updateChecklistItem = (taskIdentifier, itemIndex, newValue) => {
    if (!taskIdentifier) return;

    const currentTask = editedTasks[taskIdentifier] || findTaskByIdentifier(preparationTasks, taskIdentifier).task;
    if (!currentTask) return;

    const checklistItems = currentTask.description ? currentTask.description.split(',').map(i => i.trim()) : [];
    const updatedItems = [...checklistItems];
    updatedItems[itemIndex] = newValue;

    setEditedTasks(prev => ({
      ...prev,
      [taskIdentifier]: {
        ...currentTask,
        description: updatedItems.join(', ')
      }
    }));
  };

  const addChecklistItem = (taskIdentifier, newItem = 'New item') => {
    if (!taskIdentifier) return;

    const currentTask = editedTasks[taskIdentifier] || findTaskByIdentifier(preparationTasks, taskIdentifier).task;
    if (!currentTask) return;

    const checklistItems = currentTask.description ? currentTask.description.split(',').map(i => i.trim()) : [];
    const updatedItems = [...checklistItems, newItem];

    setEditedTasks(prev => ({
      ...prev,
      [taskIdentifier]: {
        ...currentTask,
        description: updatedItems.join(', ')
      }
    }));
  };
  
  const addTransportationToChecklist = (taskIdentifier) => {
    if (!taskIdentifier) return;

    const currentTask = editedTasks[taskIdentifier] || findTaskByIdentifier(preparationTasks, taskIdentifier).task;
    if (!currentTask) return;

    const checklistItems = currentTask.description ? currentTask.description.split(',').map(i => i.trim()) : [];
    const hasTransportation = checklistItems.some(item =>
      item.toLowerCase().includes('uber') ||
      item.toLowerCase().includes('ride') ||
      item.toLowerCase().includes('transportation')
    );

    if (!hasTransportation) {
      const updatedItems = [...checklistItems, 'Book Uber ride to event'];

      setEditedTasks(prev => ({
        ...prev,
        [taskIdentifier]: {
          ...currentTask,
          description: updatedItems.join(', '),
          category: 'Transportation'
        }
      }));
    }
  };

  const removeChecklistItem = (taskIdentifier, itemIndex) => {
    if (!taskIdentifier) return;

    const currentTask = editedTasks[taskIdentifier] || findTaskByIdentifier(preparationTasks, taskIdentifier).task;
    if (!currentTask) return;

    const checklistItems = currentTask.description ? currentTask.description.split(',').map(i => i.trim()) : [];
    const updatedItems = checklistItems.filter((_, idx) => idx !== itemIndex);

    setEditedTasks(prev => ({
      ...prev,
      [taskIdentifier]: {
        ...currentTask,
        description: updatedItems.join(', ')
      }
    }));
  };

  const updateTaskDateTime = (taskIdentifier, newDate, newTime) => {
    if (!taskIdentifier) return;

    const currentTask = editedTasks[taskIdentifier] || findTaskByIdentifier(preparationTasks, taskIdentifier).task;
    if (!currentTask) return;

    let updatedDate = currentTask.suggestedDate;
    if (newDate) {
      const dateObj = new Date(newDate);
      if (newTime) {
        const [hours, minutes] = newTime.split(':');
        dateObj.setHours(parseInt(hours, 10), parseInt(minutes, 10));
      }
      updatedDate = dateObj.toISOString();
    } else if (newTime && currentTask.suggestedDate) {
      const dateObj = new Date(currentTask.suggestedDate);
      const [hours, minutes] = newTime.split(':');
      dateObj.setHours(parseInt(hours, 10), parseInt(minutes, 10));
      updatedDate = dateObj.toISOString();
    }
    
    const now = new Date();
    const suggestedDateTime = new Date(updatedDate);
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
    
    if (suggestedDateTime <= oneHourFromNow) {
      const adjustedDate = new Date(oneHourFromNow);
      if (newTime && suggestedDateTime > now) {
        adjustedDate.setHours(suggestedDateTime.getHours(), suggestedDateTime.getMinutes());
        if (adjustedDate <= now) {
          updatedDate = oneHourFromNow.toISOString();
        } else {
          updatedDate = adjustedDate.toISOString();
        }
      } else {
        updatedDate = oneHourFromNow.toISOString();
      }
    }
    
    setEditedTasks(prev => ({
      ...prev,
      [taskIdentifier]: {
        ...currentTask,
        suggestedDate: updatedDate,
        suggestedTime: newTime || currentTask.suggestedTime || newTime
      }
    }));
  };

  const getTaskToDisplay = (task) => {
    const taskKey = getTaskIdentifier(task);
    return editedTasks[taskKey] || task;
  };

  const isTransportationTask = (task) => {
    if (!task) return false;
    const taskLower = (task.task || '').toLowerCase();
    const categoryLower = (task.category || '').toLowerCase();
    const descriptionLower = (task.description || '').toLowerCase();
    
    return (
      categoryLower.includes('transportation') ||
      categoryLower.includes('transport') ||
      taskLower.includes('uber') ||
      taskLower.includes('transportation') ||
      taskLower.includes('transport') ||
      taskLower.includes('ride') ||
      taskLower.includes('travel') ||
      taskLower.includes('arrange transport') ||
      descriptionLower.includes('uber') ||
      descriptionLower.includes('arrange transport') ||
      (descriptionLower.includes('book') && descriptionLower.includes('ride'))
    );
  };

  const handleUberBooking = (bookingData) => {
    // Handle successful Uber booking
    console.log('Uber booking completed:', bookingData);
    // You could add the booking to calendar events here if needed
  };

  const handleTaskClick = (task, e) => {
    // Prevent checkbox from triggering this
    if (e.target.type === 'checkbox' || e.target.tagName === 'LABEL' || e.target.closest('.task-selection')) {
      return;
    }
    
    if (isTransportationTask(task)) {
      setShowUberModal(true);
    }
  };

  const buttonLabel = !isAlreadyAnalyzed
    ? (loading ? 'Analyzing...' : '🧠 Generate Checklist')
    : (loading ? 'Re-generating...' : '🔄 Re-generate checklist');
  const descriptionToDisplay = editedDescription || event?.description || '';

  return (
    <div className="analysis-container">
      <div className="analysis-header">
        <h3>🤖 AI Event Analysis</h3>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      <div className="analysis-content">
          <div className="event-info">
            <h4>{event.title}</h4>
            <p className="event-meta">
              <span className="event-type-badge">{event.type}</span>
              <span className="event-date">
                {new Date(event.date).toLocaleString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true
                })}
              </span>
            </p>
            {event.location && <p className="event-location">📍 {event.location}</p>}
            
            {/* Description Section with Google Docs URL Detection */}
            <div className="event-description-section">
              <div className="description-header">
                <strong>Description:</strong>
                {/* Only show edit button for original user events, hide once tasks are scheduled or if it's AI-generated */}
                {!event.isAIGenerated && !hasScheduledTasks && (
                  <button
                    className="edit-description-btn"
                    onClick={() => setShowDescriptionEditor(!showDescriptionEditor)}
                    title="Edit description"
                  >
                    {showDescriptionEditor ? '✗ Cancel' : '✏️ Edit'}
                  </button>
                )}
              </div>
              {showDescriptionEditor ? (
                <div className="description-editor">
                  <textarea
                    className="description-textarea"
                    value={editedDescription}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setEditedDescription(nextValue);
                      setDetectedDocUrls(extractGoogleDocUrls(nextValue));
                    }}
                    placeholder="Enter event description. Paste Google Docs/Sheets URLs here for AI-powered meeting preparation."
                    rows="4"
                  />
                  <div className="description-hints">
                    <p>💡 <strong>Tip:</strong> Paste Google Docs URLs (e.g., https://docs.google.com/document/d/...) in the description for enhanced meeting preparation</p>
                  </div>
                  {detectedDocUrls.length > 0 && (
                    <div className="detected-docs">
                      <strong>📄 Detected Google Docs ({detectedDocUrls.length}):</strong>
                      {detectedDocUrls.map((url, idx) => (
                        <a key={idx} href={url.fullUrl} target="_blank" rel="noopener noreferrer" className="doc-url-link">
                          📄 Document {idx + 1}
                        </a>
                      ))}
                    </div>
                  )}
                  <button
                    className="save-description-btn"
                    onClick={async () => {
                      // Detect URLs in the edited description
                      setDetectedDocUrls(extractGoogleDocUrls(editedDescription));

                      // Close editor - description will be used when analyzing
                      setShowDescriptionEditor(false);
                      
                      // Note: For Google Calendar events, description updates would require API call
                      // For now, the edited description will be used in analysis
                    }}
                  >
                    💾 Save Description
                  </button>
                </div>
              ) : (
                <div className="event-description-display">
                  {descriptionToDisplay ? (
                    <>
                      <p className="description-text">{descriptionToDisplay}</p>
                      {detectedDocUrls.length > 0 && (
                        <div className="detected-docs-inline">
                          <strong>📄 Google Docs detected:</strong>
                          {detectedDocUrls.map((url, idx) => (
                            <a key={idx} href={url.fullUrl} target="_blank" rel="noopener noreferrer" className="doc-url-link">
                              Document {idx + 1}
                            </a>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="no-description">No description yet. Click "Edit" to add one.</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {!analysis && !loading && !error && (
            <div className="analyze-prompt">
              {event.isAIGenerated ? (
                <>
                  <p className="info-message">ℹ️ This is an AI-generated checklist task. It cannot be analyzed further.</p>
                </>
              ) : isAlreadyAnalyzed ? (
                <>
                  <p className="info-message">✅ This event has already been analyzed. Loading cached analysis...</p>
                </>
              ) : (
                <>
                  <p>Get AI-powered suggestions for preparing for this event using the action button below.</p>
                </>
              )}
            </div>
          )}

          {loading && (
            <div className="loading-analysis">
              <div className="spinner"></div>
              <p>AI is analyzing your event...</p>
            </div>
          )}

              {error && (
            <div className="error-analysis">
              <p>{error}</p>
              {!event.isAIGenerated && !isAlreadyAnalyzed && (
                <button className="retry-btn" onClick={analyzeEvent}>Try Again</button>
              )}
            </div>
          )}

          {analysis && (
            <div className="analysis-results">
              <div className="analysis-summary">
                <div className="summary-header">
                  <h5>📋 Event Summary</h5>
                  {isAlreadyAnalyzed && (
                    <span className="analyzed-badge" title="This event has been analyzed">
                      ✅ Analyzed
                    </span>
                  )}
                </div>
                <p>{analysis.eventSummary}</p>
                <div className="prep-time">
                  <strong>Estimated Prep Time:</strong> {analysis.estimatedPrepTime}
                </div>
              </div>

              {analysis.mealPlan && (
                 <div className="meal-plan-info" style={{ marginBottom: '20px', padding: '15px', background: '#f0fdf4', borderRadius: '8px', border: '1px solid #86efac' }}>
                   <h5>🍽️ Meal Plan Generated</h5>
                  {analysis.mealPlan.message && (
                    <p style={{ margin: '10px 0' }}>{analysis.mealPlan.message}</p>
                  )}
                  
                  {/* Display nutrition summary if available */}
                  {analysis.mealPlan.nutrients && (
                    <div style={{ 
                      display: 'grid', 
                      gridTemplateColumns: 'repeat(4, 1fr)', 
                      gap: '10px', 
                      marginTop: '15px',
                      marginBottom: '15px',
                      padding: '10px',
                      background: '#ecfdf5',
                      borderRadius: '6px'
                    }}>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>Calories</div>
                        <div style={{ fontSize: '18px', fontWeight: '600', color: '#059669' }}>
                          {Math.round(analysis.mealPlan.nutrients.calories)}
                        </div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>Protein</div>
                        <div style={{ fontSize: '18px', fontWeight: '600', color: '#059669' }}>
                          {Math.round(analysis.mealPlan.nutrients.protein)}g
                        </div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>Carbs</div>
                        <div style={{ fontSize: '18px', fontWeight: '600', color: '#059669' }}>
                          {Math.round(analysis.mealPlan.nutrients.carbohydrates)}g
                        </div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>Fat</div>
                        <div style={{ fontSize: '18px', fontWeight: '600', color: '#059669' }}>
                          {Math.round(analysis.mealPlan.nutrients.fat)}g
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Display meals grouped by day */}
                  {analysis.mealPlan.meals && analysis.mealPlan.meals.length > 0 && (
                    <div style={{ marginTop: '15px' }}>
                      {(() => {
                        // Group meals by day
                        const mealsByDay = {};
                        analysis.mealPlan.meals.forEach(meal => {
                          if (!mealsByDay[meal.day]) {
                            mealsByDay[meal.day] = [];
                          }
                          mealsByDay[meal.day].push(meal);
                        });

                        return Object.keys(mealsByDay).sort((a, b) => parseInt(a) - parseInt(b)).map(day => (
                          <div key={day} style={{ marginBottom: '20px' }}>
                            <h6 style={{ 
                              fontSize: '14px', 
                              fontWeight: '600', 
                              color: '#047857',
                              marginBottom: '10px',
                              paddingBottom: '5px',
                              borderBottom: '2px solid #86efac'
                            }}>
                              Day {day}
                            </h6>
                            <div style={{ display: 'grid', gap: '10px' }}>
                              {mealsByDay[day].map((meal, idx) => (
                                <div key={idx} style={{
                                  padding: '12px',
                                  background: 'white',
                                  borderRadius: '6px',
                                  border: '1px solid #d1fae5'
                                }}>
                                  <div style={{ 
                                    display: 'flex', 
                                    justifyContent: 'space-between',
                                    alignItems: 'flex-start',
                                    marginBottom: '8px'
                                  }}>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ 
                                        fontSize: '11px', 
                                        fontWeight: '600', 
                                        color: '#6b7280',
                                        textTransform: 'uppercase',
                                        marginBottom: '4px'
                                      }}>
                                        {meal.mealType}
                                      </div>
                                      <div style={{ 
                                        fontSize: '14px', 
                                        fontWeight: '600', 
                                        color: '#1f2937',
                                        marginBottom: '4px'
                                      }}>
                                        {meal.title}
                                      </div>
                                      <div style={{ 
                                        fontSize: '12px', 
                                        color: '#6b7280',
                                        display: 'flex',
                                        gap: '12px',
                                        flexWrap: 'wrap'
                                      }}>
                                        {meal.readyInMinutes && (
                                          <span>⏱️ {meal.readyInMinutes} min</span>
                                        )}
                                        {meal.servings && (
                                          <span>🍽️ {meal.servings} servings</span>
                                        )}
                                      </div>
                                    </div>
                                    {meal.image && (
                                      <img 
                                        src={meal.image} 
                                        alt={meal.title}
                                        style={{
                                          width: '80px',
                                          height: '80px',
                                          objectFit: 'cover',
                                          borderRadius: '6px',
                                          marginLeft: '12px'
                                        }}
                                      />
                                    )}
                                  </div>
                                  {meal.summary && (
                                    <div style={{ 
                                      fontSize: '12px', 
                                      color: '#4b5563',
                                      marginBottom: '8px',
                                      lineHeight: '1.4'
                                    }}>
                                      {meal.summary}
                                    </div>
                                  )}
                                  {meal.sourceUrl && (
                                    <a 
                                      href={meal.sourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{
                                        fontSize: '12px',
                                        color: '#059669',
                                        textDecoration: 'none',
                                        fontWeight: '500'
                                      }}
                                    >
                                      View Recipe →
                                    </a>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  )}

                  {/* Fallback text display (for LLM-generated plans) */}
                  {analysis.mealPlan.fallback && !analysis.mealPlan.meals && (
                    <div style={{
                      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      padding: '20px',
                      borderRadius: '12px',
                      marginTop: '15px',
                      color: 'white',
                      boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                    }}>
                      <div style={{
                        background: 'rgba(255,255,255,0.95)',
                        padding: '15px',
                        borderRadius: '8px',
                        color: '#1a202c',
                        whiteSpace: 'pre-wrap',
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        fontSize: '14px',
                        lineHeight: '1.8',
                        maxHeight: '500px',
                        overflowY: 'auto'
                      }}>
                        {analysis.mealPlan.fallback}
                      </div>
                      <div style={{
                        marginTop: '12px',
                        fontSize: '12px',
                        opacity: 0.9,
                        textAlign: 'center'
                      }}>
                        💡 This meal plan was generated by AI as a fallback
                      </div>
                    </div>
                  )}

                  {/* Formatted text display (for Spoonacular plans) */}
                  {analysis.mealPlan.formattedText && analysis.mealPlan.meals && (
                    <details style={{ marginTop: '15px' }}>
                      <summary style={{ 
                        cursor: 'pointer', 
                        fontSize: '13px', 
                        color: '#059669',
                        fontWeight: '500'
                      }}>
                        View as Text
                      </summary>
                      <pre style={{
                        background: '#ecfdf5',
                        padding: '12px',
                        borderRadius: '6px',
                        whiteSpace: 'pre-wrap',
                        marginTop: '8px',
                        fontFamily: 'var(--font-monospace, monospace)',
                        fontSize: '12px',
                        lineHeight: '1.6'
                      }}>
                        {analysis.mealPlan.formattedText}
                      </pre>
                    </details>
                  )}
                 </div>
               )}

              {analysis.weather && (
                <div className="weather-info">
                  <h5>🌤️ Weather Forecast</h5>
                  <div className="weather-details">
                    <div className="weather-main">
                      <div className="weather-temp">
                        <span className="temp-value">{analysis.weather.temperature}°C</span>
                        <span className="temp-feels">Feels like {analysis.weather.feelsLike}°C</span>
                      </div>
                      <div className="weather-condition">
                        <span className="condition-text">{analysis.weather.description}</span>
                        <span className="condition-location">📍 {analysis.weather.location}</span>
                      </div>
                    </div>
                    <div className="weather-stats">
                      <div className="weather-stat">
                        <span className="stat-icon">💧</span>
                        <span className="stat-value">{analysis.weather.precipitation}%</span>
                        <span className="stat-label">Rain</span>
                      </div>
                      <div className="weather-stat">
                        <span className="stat-icon">💨</span>
                        <span className="stat-value">{analysis.weather.windSpeed}</span>
                        <span className="stat-label">km/h</span>
                      </div>
                      <div className="weather-stat">
                        <span className="stat-icon">💦</span>
                        <span className="stat-value">{analysis.weather.humidity}%</span>
                        <span className="stat-label">Humidity</span>
                      </div>
                    </div>
                    {analysis.weather.suggestions && analysis.weather.suggestions.length > 0 && (
                      <div className="weather-suggestions">
                        <strong>Weather-based suggestions:</strong>
                        <ul>
                          {analysis.weather.suggestions.map((suggestion, idx) => (
                            <li key={idx}>{suggestion}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="preparation-tasks">
                <h5>✅ Preparation Tasks</h5>
                <p className="task-selection-info">
                  {analysis?.remainingTasksOnly
                    ? 'These are the remaining checklist tasks that have not been scheduled yet.'
                    : 'Select tasks to add to your calendar:'}
                </p>
                {hasPreparationTasks ? (
                  <div className="tasks-grid">
                    {preparationTasks.map((task, index) => {
                    const displayTask = getTaskToDisplay(task);
                    const taskKey = getTaskIdentifier(task);
                    const isEditing = editingTaskId === taskKey;
                    const checkboxId = `task-${index}`;
                    let checklistItems = [];
                    if (displayTask.description) {
                      const rawDescription = displayTask.description;
                      checklistItems = rawDescription
                        .split(/\r?\n/)
                        .map(item => item.replace(/^[\u2022•*-]+\s*/, '').trim())
                        .filter(Boolean);

                      if (checklistItems.length <= 1 && rawDescription.includes(',')) {
                        checklistItems = rawDescription
                          .split(',')
                          .map(item => item.trim())
                          .filter(Boolean);
                      }
                    }
                    const suggestedDate = displayTask.suggestedDate ? new Date(displayTask.suggestedDate) : null;
                    // Extract time from suggestedDate if it's a datetime, otherwise use suggestedTime
                    const taskTime = displayTask.suggestedTime || 
                                    (suggestedDate && suggestedDate.toTimeString().slice(0, 5)) || 
                                    '09:00';
                    
                    return (
                      <div 
                        key={taskKey} 
                        className={`task-card ${isTransportationTask(task) ? 'transportation-task' : ''} ${isEditing ? 'editing' : ''}`}
                        onClick={(e) => handleTaskClick(task, e)}
                        style={isTransportationTask(task) ? { cursor: 'pointer' } : {}}
                      >
                        <div className="task-selection">
                          <input
                            type="checkbox"
                            id={checkboxId}
                            checked={selectedTasks.some(t => (t.__taskKey || getTaskIdentifier(t)) === taskKey)}
                            onChange={(e) => handleTaskSelection(task, index, e.target.checked)}
                            className="task-checkbox"
                          />
                          <label htmlFor={checkboxId} className="task-select-label">
                            Add to Calendar
                          </label>
                          <button
                            className="edit-task-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              console.log('[edit-task] Toggling edit mode for task:', taskKey, 'Current isEditing:', isEditing);
                              setEditingTaskId(isEditing ? null : taskKey);
                            }}
                            title={isEditing ? "Done Editing" : "Edit Task"}
                          >
                            {isEditing ? '✓' : '✏️'}
                          </button>
                        </div>
                        <div className="task-header">
                          <span 
                            className="priority-badge"
                            style={{ backgroundColor: getPriorityColor(displayTask.priority) }}
                          >
                            {displayTask.priority}
                          </span>
                          <span className="task-time">{displayTask.estimatedTime}</span>
                        </div>
                        <h6>{displayTask.task}</h6>
                        <p className="task-category">{displayTask.category}</p>
                        
                        {(displayTask.description || isEditing) && (
                          <div className="task-checklist">
                            <div className="checklist-header">
                              <strong>Checklist:</strong>
                              {isEditing && (
                                <div className="checklist-actions">
                                  <button
                                    className="add-ride-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      addTransportationToChecklist(taskKey);
                                    }}
                                    title="Add transportation/ride option"
                                  >
                                    🚕 Add Ride
                                  </button>
                                  <button
                                    className="add-item-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      addChecklistItem(taskKey);
                                    }}
                                    title="Add item"
                                  >
                                    + Add Item
                                  </button>
                                </div>
                              )}
                            </div>
                            {checklistItems.length > 0 ? (
                              <ul className="checklist-items">
                                {checklistItems.map((item, idx) => (
                                  <li key={idx}>
                                    {isEditing ? (
                                      <div className="checklist-item-editable">
                                        <input
                                          type="text"
                                          value={item}
                                          onChange={(e) => updateChecklistItem(taskKey, idx, e.target.value)}
                                          className="checklist-item-input"
                                          onClick={(e) => e.stopPropagation()}
                                          placeholder="Enter checklist item"
                                        />
                                        <button
                                          className="remove-item-btn"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            removeChecklistItem(taskKey, idx);
                                          }}
                                          title="Remove item"
                                        >
                                          ×
                                        </button>
                                      </div>
                                    ) : (
                                      item
                                    )}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              isEditing && (
                                <p className="no-checklist-items">No items yet. Click "+ Add Item" to add one.</p>
                              )
                            )}
                          </div>
                        )}
                        
                        <div className="task-suggested-date">
                          {isEditing ? (
                            <div className="datetime-edit" onClick={(e) => e.stopPropagation()}>
                              <label>
                                <strong>Date:</strong>
                                <input
                                  type="date"
                                  min={new Date().toISOString().split('T')[0]}
                                  value={suggestedDate ? suggestedDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0]}
                                  onChange={(e) => updateTaskDateTime(taskKey, e.target.value, null)}
                                  className="date-input"
                                />
                              </label>
                              <label>
                                <strong>Time:</strong>
                                <input
                                  type="time"
                                  min={(() => {
                                    // If date is today, set min time to 1 hour from now
                                    const now = new Date();
                                    const taskDate = suggestedDate ? new Date(suggestedDate) : null;
                                    if (taskDate && taskDate.toDateString() === now.toDateString()) {
                                      // Same day, set min to 1 hour from now
                                      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
                                      return `${oneHourFromNow.getHours().toString().padStart(2, '0')}:${oneHourFromNow.getMinutes().toString().padStart(2, '0')}`;
                                    }
                                    return '00:00';
                                  })()}
                                  value={taskTime}
                                  onChange={(e) => updateTaskDateTime(taskKey, null, e.target.value)}
                                  className="time-input"
                                />
                              </label>
                            </div>
                          ) : (
                            suggestedDate ? (
                              <p>
                                <strong>Suggested date:</strong> {suggestedDate.toLocaleDateString()}
                                {taskTime && ` at ${taskTime}`}
                              </p>
                            ) : (
                              <p className="no-date-notice">No date set - click ✏️ to edit</p>
                            )
                          )}
                        </div>
                        
                        {isTransportationTask(task) && (
                          <button 
                            className="uber-booking-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowUberModal(true);
                            }}
                          >
                            🚕 Book Uber Ride
                          </button>
                        )}
                      </div>
                    );
                  })}
                  </div>
                ) : (
                  <div className="no-remaining-tasks">
                    <p>
                      {hasLinkedTasks
                        ? 'All checklist items from this checklist are on your calendar.'
                        : (hasScheduledTasks || isAlreadyAnalyzed)
                        ? 'All checklist items have already been added to your calendar. 🎉'
                        : 'No checklist items were generated. Try regenerating or check the event details.'}
                    </p>
                    <p className="no-remaining-subtext">
                      {hasLinkedTasks || hasScheduledTasks || isAlreadyAnalyzed
                        ? 'Modify these tasks directly from your calendar if plans change.'
                        : 'Click "Generate Checklist" to create tasks for this event.'}
                    </p>
                  </div>
                )}
              </div>

              {hasLinkedTasks && (
                <div className="linked-tasks-section">
                  <h5>✅ Already Scheduled</h5>
                  <p className="linked-tasks-subtext">
                    These tasks have been added to your calendar and cannot be scheduled again.
                  </p>
                  <div className="linked-tasks-list">
                    {linkedTasks.map((task) => (
                      <div key={task.id || getTaskIdentifier(task)} className="linked-task-card">
                        <div className="linked-task-header">
                          <span className="linked-task-title">✓ {task.title || task.task || 'Checklist Item'}</span>
                          {task.priority && (
                            <span className="linked-task-priority">{task.priority}</span>
                          )}
                        </div>
                        <div className="linked-task-meta">
                          <span>{formatLinkedTaskDate(task.date)}</span>
                          {task.category && <span>• {task.category}</span>}
                          {task.estimatedTime && <span>• {task.estimatedTime}</span>}
                        </div>
                        {task.description && (
                          <p className="linked-task-description">{task.description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}
        </div>

        {/* Action buttons - outside scrollable area */}
        <div className="analysis-actions">
          <div className="action-buttons">
            {/* Hide "Generate Checklist" button after any tasks are scheduled - only show "Add to Calendar" */}
            {!event.isAIGenerated && !hasScheduledTasks && !hasLinkedTasks && (
              <button
                className="reanalyze-btn"
                onClick={handleGenerateChecklist}
                disabled={loading}
                title={
                  isAlreadyAnalyzed
                    ? 'Update the checklist before scheduling tasks'
                    : 'Generate a checklist for this event'
                }
              >
                {buttonLabel}
              </button>
            )}
            {analysis && (
              <button
                className="add-tasks-btn"
                onClick={addSelectedTasksToCalendar}
                disabled={selectedTasks.length === 0}
                title="Add selected tasks to your calendar"
              >
                {addingTasks ? '⏳ Adding...' : '📅 Add to Calendar'}
              </button>
            )}
          </div>
        </div>

        {showUberModal && (
          <UberBookingModal
            event={event}
            onClose={() => setShowUberModal(false)}
            onBook={handleUberBooking}
          />
        )}

        {/* Meal Plan Preferences Modal */}
        {showMealPlanModal && (
          <div className="meal-plan-modal-overlay" onClick={() => setShowMealPlanModal(false)}>
            <div className="meal-plan-modal" onClick={(e) => e.stopPropagation()}>
              <div className="meal-plan-modal-header">
                <h3>🍽️ Meal Planning Preferences</h3>
                <button className="close-btn" onClick={() => setShowMealPlanModal(false)}>×</button>
              </div>
              <div className="meal-plan-modal-content">
                <p>To generate your personalized meal plan, please provide the following information:</p>
                
                <div className="meal-plan-form">
                  <label>
                    <strong>Number of Days:</strong>
                    <input
                      type="number"
                      min="1"
                      max="7"
                      value={mealPlanPreferences.days}
                      onChange={(e) => setMealPlanPreferences({
                        ...mealPlanPreferences,
                        days: parseInt(e.target.value) || 7
                      })}
                    />
                  </label>

                  <label>
                    <strong>Number of People:</strong>
                    <input
                      type="number"
                      min="1"
                      placeholder="e.g., 4"
                      value={mealPlanPreferences.familySize}
                      onChange={(e) => setMealPlanPreferences({
                        ...mealPlanPreferences,
                        familySize: e.target.value
                      })}
                    />
                  </label>

                  <label>
                    <strong>Daily Calorie Target:</strong>
                    <input
                      type="number"
                      min="1000"
                      max="5000"
                      step="100"
                      value={mealPlanPreferences.targetCalories}
                      onChange={(e) => setMealPlanPreferences({
                        ...mealPlanPreferences,
                        targetCalories: parseInt(e.target.value) || 2000
                      })}
                    />
                  </label>

                  <label>
                    <strong>Dietary Preference (optional):</strong>
                    <select
                      value={mealPlanPreferences.diet}
                      onChange={(e) => setMealPlanPreferences({
                        ...mealPlanPreferences,
                        diet: e.target.value
                      })}
                    >
                      <option value="">None</option>
                      <option value="vegetarian">Vegetarian</option>
                      <option value="vegan">Vegan</option>
                      <option value="paleo">Paleo</option>
                      <option value="primal">Primal</option>
                      <option value="ketogenic">Ketogenic</option>
                      <option value="pescetarian">Pescetarian</option>
                    </select>
                  </label>

                  <label>
                    <strong>Exclude Ingredients (comma-separated, optional):</strong>
                    <input
                      type="text"
                      placeholder="e.g., shellfish, nuts, dairy"
                      value={mealPlanPreferences.exclude}
                      onChange={(e) => setMealPlanPreferences({
                        ...mealPlanPreferences,
                        exclude: e.target.value
                      })}
                    />
                  </label>
                </div>

                {error && (
                  <div className="error-message" style={{ color: '#ff4757', marginTop: '10px' }}>
                    {error}
                  </div>
                )}

                <div className="meal-plan-modal-actions">
                  <button
                    className="cancel-btn"
                    onClick={() => {
                      setShowMealPlanModal(false);
                      if (pendingAnalysis) {
                        // User skipped meal plan preferences, analyze without them
                        setPendingAnalysis(false);
                        analyzeEvent();
                      }
                    }}
                    disabled={generatingMealPlan}
                  >
                    {pendingAnalysis ? 'Skip Meal Plan' : 'Cancel'}
                  </button>
                  <button
                    className="generate-btn"
                    onClick={handleGenerateMealPlan}
                    disabled={generatingMealPlan}
                  >
                    {generatingMealPlan ? '⏳ Generating...' : '🍽️ Generate Meal Plan'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
    </div>
  );
};

export default EventAnalysis;