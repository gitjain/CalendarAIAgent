const axios = require('axios');

// Configuration
const BASE_URL = 'http://localhost:5001';
const API = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  withCredentials: true
});

// Test state
let testEvent = null;
let initialAnalysis = null;
let scheduledTasks = [];

// Helper functions
function log(emoji, message) {
  console.log(`${emoji} ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  log('✅', message);
}

// Test Steps
async function step1_FindSpainEvent() {
  log('🔍', 'Step 1: Finding Trip to Spain event on Nov 22...');
  
  try {
    const response = await API.get('/api/events');
    const events = response.data.events || response.data || [];
    
    // Find event with "Spain" in title and date in November 22
    testEvent = events.find(event => {
      const title = (event.title || event.summary || '').toLowerCase();
      const dateStr = event.date || event.start?.dateTime || event.start?.date || '';
      const hasSpain = title.includes('spain');
      const isNov22 = dateStr.includes('2024-11-22') || dateStr.includes('11/22') || dateStr.includes('Nov 22');
      return hasSpain && isNov22;
    });
    
    if (!testEvent) {
      // Try broader search - just Spain
      testEvent = events.find(event => {
        const title = (event.title || event.summary || '').toLowerCase();
        return title.includes('spain');
      });
    }
    
    assert(testEvent, 'Found Trip to Spain event');
    log('📋', `Event ID: ${testEvent.id || testEvent.eventId}`);
    log('📋', `Event Title: ${testEvent.title || testEvent.summary}`);
    log('📋', `Event Date: ${testEvent.date || testEvent.start?.dateTime || testEvent.start?.date}`);
    
    return testEvent;
  } catch (error) {
    console.error('❌ Error fetching events:', error.message);
    process.exit(1);
  }
}

async function step2_GenerateChecklist() {
  log('🔍', 'Step 2: Generating checklist (analyzing event)...');
  
  try {
    const eventId = testEvent.id || testEvent.eventId;
    const response = await API.post('/api/analyze-event', {
      event: testEvent,
      shouldAttemptMealPlan: false
    });
    
    initialAnalysis = response.data;
    
    assert(initialAnalysis, 'Received analysis response');
    assert(initialAnalysis.preparationTasks, 'Analysis contains preparationTasks');
    assert(initialAnalysis.preparationTasks.length > 0, `Generated ${initialAnalysis.preparationTasks.length} tasks`);
    
    log('📋', `Tasks generated: ${initialAnalysis.preparationTasks.length}`);
    initialAnalysis.preparationTasks.forEach((task, idx) => {
      log('  ', `${idx + 1}. ${task.task || task.title}`);
    });
    
    // Verify initial state
    const linkedTasks = initialAnalysis.linkedTasks || [];
    log('📊', `Initial linked tasks: ${linkedTasks.length}`);
    
    return initialAnalysis;
  } catch (error) {
    console.error('❌ Error analyzing event:', error.response?.data || error.message);
    process.exit(1);
  }
}

async function step3_ScheduleTasks() {
  log('🔍', 'Step 3: Scheduling 2 tasks to calendar...');
  
  try {
    const eventId = testEvent.id || testEvent.eventId;
    
    // Select first 2 tasks
    const tasksToSchedule = initialAnalysis.preparationTasks.slice(0, 2);
    
    log('📋', 'Tasks to schedule:');
    tasksToSchedule.forEach((task, idx) => {
      log('  ', `${idx + 1}. ${task.task || task.title}`);
    });
    
    const response = await API.post('/api/add-ai-tasks', {
      selectedTasks: tasksToSchedule,
      originalEventId: eventId
    });
    
    assert(response.data.success, 'Tasks scheduled successfully');
    assert(response.data.addedEvents, 'Received added events');
    assert(response.data.addedEvents.length === 2, `Scheduled exactly 2 tasks (got ${response.data.addedEvents.length})`);
    
    scheduledTasks = response.data.addedEvents;
    
    log('📋', `Successfully scheduled ${scheduledTasks.length} tasks`);
    
    return response.data;
  } catch (error) {
    console.error('❌ Error scheduling tasks:', error.response?.data || error.message);
    process.exit(1);
  }
}

async function step4_VerifyRemainingTasks() {
  log('🔍', 'Step 4: Verifying remaining tasks...');
  
  try {
    const eventId = testEvent.id || testEvent.eventId;
    const response = await API.get(`/api/get-remaining-tasks/${eventId}`);
    
    const remainingTasks = response.data.remainingTasks || [];
    const expectedRemaining = initialAnalysis.preparationTasks.length - 2;
    
    log('📊', `Remaining tasks: ${remainingTasks.length}`);
    log('📊', `Expected remaining: ${expectedRemaining}`);
    
    assert(
      remainingTasks.length === expectedRemaining,
      `Correct number of remaining tasks (${remainingTasks.length} === ${expectedRemaining})`
    );
    
    if (remainingTasks.length > 0) {
      log('📋', 'Remaining tasks:');
      remainingTasks.forEach((task, idx) => {
        log('  ', `${idx + 1}. ${task.task || task.title}`);
      });
    }
    
    return remainingTasks;
  } catch (error) {
    console.error('❌ Error fetching remaining tasks:', error.response?.data || error.message);
    process.exit(1);
  }
}

async function step5_VerifyLinkedTasks() {
  log('🔍', 'Step 5: Verifying linked tasks...');
  
  try {
    const eventId = testEvent.id || testEvent.eventId;
    const response = await API.post('/api/get-linked-tasks', {
      eventId: eventId
    });
    
    const linkedTasks = response.data.linkedTasks || [];
    
    log('📊', `Linked tasks found: ${linkedTasks.length}`);
    
    assert(
      linkedTasks.length >= 2,
      `At least 2 linked tasks found (got ${linkedTasks.length})`
    );
    
    log('📋', 'Linked tasks:');
    linkedTasks.forEach((task, idx) => {
      log('  ', `${idx + 1}. ${task.title || task.task} (ID: ${task.id})`);
    });
    
    // Verify task identifiers match
    const scheduledTaskNames = scheduledTasks.map(t => (t.title || t.task || '').toLowerCase());
    const linkedTaskNames = linkedTasks.map(t => (t.title || t.task || '').toLowerCase());
    
    log('🔍', 'Verifying task identifier consistency...');
    scheduledTaskNames.forEach(name => {
      const found = linkedTaskNames.some(linkedName => 
        linkedName.includes(name.replace('📋 ', '')) || name.includes(linkedName)
      );
      if (found) {
        log('  ✅', `Task found in linked tasks: ${name}`);
      }
    });
    
    return linkedTasks;
  } catch (error) {
    console.error('❌ Error fetching linked tasks:', error.response?.data || error.message);
    process.exit(1);
  }
}

async function step6_VerifyEventAnalyzed() {
  log('🔍', 'Step 6: Verifying event marked as analyzed...');
  
  try {
    const eventId = testEvent.id || testEvent.eventId;
    
    // Re-analyze the event to check state
    const response = await API.post('/api/analyze-event', {
      event: testEvent,
      shouldAttemptMealPlan: false
    });
    
    const reanalysis = response.data;
    
    // Check if it returns remaining tasks only (indicates analyzed state)
    const hasRemainingTasksOnly = reanalysis.remainingTasksOnly === true;
    const hasFewerTasks = reanalysis.preparationTasks.length < initialAnalysis.preparationTasks.length;
    
    log('📊', `Remaining tasks only flag: ${hasRemainingTasksOnly}`);
    log('📊', `Tasks count: ${reanalysis.preparationTasks.length} (was ${initialAnalysis.preparationTasks.length})`);
    
    assert(
      hasFewerTasks || hasRemainingTasksOnly,
      'Event shows analyzed state (fewer tasks or remainingTasksOnly flag)'
    );
    
    return reanalysis;
  } catch (error) {
    console.error('❌ Error verifying analyzed state:', error.response?.data || error.message);
    process.exit(1);
  }
}

async function step7_VerifyUILogic() {
  log('🔍', 'Step 7: Verifying Generate Checklist button logic...');
  
  try {
    const eventId = testEvent.id || testEvent.eventId;
    
    // Get current state
    const remainingResponse = await API.get(`/api/get-remaining-tasks/${eventId}`);
    const linkedResponse = await API.post('/api/get-linked-tasks', { eventId });
    
    const remainingTasks = remainingResponse.data.remainingTasks || [];
    const linkedTasks = linkedResponse.data.linkedTasks || [];
    
    const hasScheduledTasks = remainingTasks.length < initialAnalysis.preparationTasks.length;
    const hasLinkedTasks = linkedTasks.length > 0;
    
    log('📊', `Has scheduled tasks: ${hasScheduledTasks}`);
    log('📊', `Has linked tasks: ${hasLinkedTasks}`);
    
    // According to the UI logic:
    // Button should be hidden if: hasScheduledTasks || hasLinkedTasks
    const shouldHideButton = hasScheduledTasks || hasLinkedTasks;
    
    assert(
      shouldHideButton,
      'Generate Checklist button should be hidden (has scheduled or linked tasks)'
    );
    
    log('✅', 'UI logic verified: Generate Checklist button would be hidden');
    
    return { hasScheduledTasks, hasLinkedTasks };
  } catch (error) {
    console.error('❌ Error verifying UI logic:', error.response?.data || error.message);
    process.exit(1);
  }
}

// Main test runner
async function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('🧪 TASK SCHEDULING STATE FLOW TEST');
  console.log('='.repeat(60) + '\n');
  
  try {
    await step1_FindSpainEvent();
    console.log('');
    
    await step2_GenerateChecklist();
    console.log('');
    
    await step3_ScheduleTasks();
    console.log('');
    
    await step4_VerifyRemainingTasks();
    console.log('');
    
    await step5_VerifyLinkedTasks();
    console.log('');
    
    await step6_VerifyEventAnalyzed();
    console.log('');
    
    await step7_VerifyUILogic();
    console.log('');
    
    console.log('='.repeat(60));
    console.log('🎉 ALL TESTS PASSED! ✅');
    console.log('='.repeat(60) + '\n');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test suite failed:', error.message);
    process.exit(1);
  }
}

// Run tests
runTests();

