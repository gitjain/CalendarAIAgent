// Test script to verify LLM fallback for meal planning
const EventAgent = require('./server/services/eventAgent');

async function testMealPlanFallback() {
  console.log('🧪 Testing LLM Meal Plan Fallback...\n');

  const agent = new EventAgent();

  // Create a mock meal prep event
  const mockEvent = {
    title: 'Weekly Meal Prep',
    description: 'Prepare healthy meals for the week',
    date: new Date().toISOString(),
    location: 'Home'
  };

  // Mock preferences (what user would submit via form)
  const mockPreferences = {
    days: 7,
    people: 2,
    targetCalories: 2000,
    diet: 'balanced',
    exclude: 'none'
  };

  try {
    console.log('1️⃣ Testing LLM fallback generation directly...');
    
    // Call the private method through analyzeEvent
    const result = await agent.analyzeEvent(mockEvent, {
      tokens: null, // No Google tokens to force fallback
      mealPlanPreferences: mockPreferences,
      shouldAttemptMealPlan: true
    });

    if (result.mealPlanFallback) {
      console.log('✅ LLM Fallback Generated Successfully!');
      console.log('\n📋 Meal Plan Preview:');
      console.log(result.mealPlanFallback.substring(0, 500) + '...\n');
      
      console.log('✅ Test Result: LLM fallback is working correctly');
      console.log('\n📊 Summary:');
      console.log('   - Preferences used: days=' + mockPreferences.days + ', people=' + mockPreferences.people);
      console.log('   - Diet: ' + mockPreferences.diet);
      console.log('   - Calories: ' + mockPreferences.targetCalories);
      console.log('   - Source: LLM (AI-generated)');
      
    } else if (result.mealPlanResult) {
      console.log('✅ Spoonacular API worked (no fallback needed)');
      console.log('   This means your Spoonacular API key is configured correctly.');
    } else if (result.mealPlanError) {
      console.log('⚠️  Both Spoonacular and LLM fallback failed');
      console.log('   Error:', result.mealPlanError.message);
    } else {
      console.log('ℹ️  No meal plan generated (shouldAttemptMealPlan might be false)');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('   Stack:', error.stack);
  }
}

// Run the test
testMealPlanFallback().then(() => {
  console.log('\n✨ Test complete!');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

