/**
 * Color Classification Service
 * Hybrid approach: Google Calendar colors → Cache → Keyword Rules → LLM
 */

class ColorClassificationService {
  constructor() {
    // Cache for color classifications (title → color class)
    this.colorCache = new Map();
    
    // Google Calendar colorId to our color class mapping
    this.googleColorMap = {
      1: 'color-general',   // Lavender
      2: 'color-everyday',  // Sage (green)
      3: 'color-concert',   // Grape (purple)
      4: 'color-celebration', // Flamingo (pink)
      5: 'color-todo',      // Banana (yellow)
      6: 'color-doctor',    // Tangerine (orange)
      7: 'color-travel',    // Peacock (teal)
      8: 'color-general',   // Graphite (gray)
      9: 'color-work',      // Blueberry (blue)
      10: 'color-everyday', // Basil (green)
      11: 'color-doctor'    // Tomato (red-orange)
    };
    
    // Expanded keyword rules for work events
    this.workKeywords = [
      // Meetings & Collaboration
      'meeting', 'call', 'sync', 'standup', 'stand-up', 'scrum', 'daily', 'dailies',
      'huddle', 'check-in', 'touchbase', 'touch base', 'briefing', 'debrief',
      
      // Planning & Strategy
      'roadmap', 'roadmapping', 'planning', 'strategy', 'strategic', 'quarterly',
      'annual', 'sprint', 'sprint planning', 'sprint review', 'sprint retrospective',
      'retro', 'grooming', 'estimation', 'refinement', 'backlog',
      
      // Development & Technical
      'epic', 'feature', 'story', 'task', 'jira', 'confluence', 'architecture',
      'design review', 'code review', 'technical review', 'deploy', 'deployment',
      'release', 'launch', 'qa', 'testing', 'qa review', 'bug', 'triage',
      
      // Business & Project Management
      'project', 'project review', 'milestone', 'deliverable', 'stakeholder',
      'alignment', 'status', 'status update', 'progress', 'report', 'presentation',
      'demo', 'demonstration', 'showcase', 'walkthrough', 'workshop', 'training',
      'onboarding', 'offboarding', 'kickoff', 'kick-off',
      
      // Work-related terms
      'work', 'work session', 'work time', 'focus time', 'deep work', 'vas',
      'one-on-one', '1-on-1', 'one-on-ones', 'team', 'team meeting',
      'all-hands', 'all hands', 'town hall'
    ];
    
    // Keyword rules for other categories
    this.categoryRules = {
      'color-doctor': [
        'doctor', 'appointment', 'medical', 'dentist', 'clinic', 'hospital',
        'checkup', 'check-up', 'examination', 'surgery', 'therapy', 'therapist'
      ],
      'color-todo': [
        'todo', 'to-do', 'reminder', 'task', 'task list', 'due', 'deadline',
        'follow up', 'follow-up', 'action item', 'note', 'notes'
      ],
      'color-everyday': [
        'practice', 'rehearsal', 'gym', 'exercise', 'workout', 'training',
        'preparation', 'prep', 'band practice'
      ],
      'color-work-daily': [
        'scrum', 'standup', 'stand-up', 'daily', 'dailies', 'huddle'
      ],
      'color-travel': [
        'travel', 'trip', 'flight', 'airport', 'hotel', 'vacation',
        'journey', 'departure', 'arrival'
      ],
      'color-celebration': [
        'birthday', 'anniversary', 'party', 'celebration', 'festival',
        'holiday', 'wedding', 'graduation'
      ],
      'color-concert': [
        'concert', 'show', 'performance', 'music', 'gig', 'recital',
        'symphony', 'orchestra'
      ]
    };
  }
  
  /**
   * Get color class for an event using hybrid approach
   * @param {Object} event - Event object
   * @returns {string} Color class name
   */
  async getColorClass(event) {
    if (!event) return 'color-general';
    
    // Step 1: Check Google Calendar colorId (if available)
    if (event.colorId && event.source === 'google') {
      const googleColor = this.googleColorMap[event.colorId];
      if (googleColor) {
        return googleColor;
      }
    }
    
    // Normalize event title for cache key
    const cacheKey = (event.title || '').toLowerCase().trim();
    if (!cacheKey) return 'color-general';
    
    // Step 2: Check cache
    if (this.colorCache.has(cacheKey)) {
      return this.colorCache.get(cacheKey);
    }
    
    const eventTitle = cacheKey;
    const eventType = (event.type || '').toLowerCase();
    const eventCategory = (event.category || '').toLowerCase();
    
    // Step 3: Check improved keyword rules
    const keywordColor = this.checkKeywordRules(eventTitle, eventType, eventCategory);
    if (keywordColor) {
      this.colorCache.set(cacheKey, keywordColor);
      return keywordColor;
    }
    
    // Step 4: LLM classification for edge cases (only if no keyword match)
    try {
      const llmColor = await this.classifyWithLLM(eventTitle, eventType, eventCategory);
      if (llmColor) {
        this.colorCache.set(cacheKey, llmColor);
        return llmColor;
      }
    } catch (error) {
      console.error('LLM color classification failed:', error);
      // Fall through to default
    }
    
    // Final fallback
    const defaultColor = 'color-general';
    this.colorCache.set(cacheKey, defaultColor);
    return defaultColor;
  }
  
  /**
   * Check keyword rules for color classification
   */
  checkKeywordRules(eventTitle, eventType, eventCategory) {
    const combinedText = `${eventTitle} ${eventType} ${eventCategory}`.toLowerCase();
    
    // Doctor/Medical (highest priority)
    if (this.categoryRules['color-doctor'].some(keyword => combinedText.includes(keyword))) {
      return 'color-doctor';
    }
    
    // Daily/Scrum/Standup meetings - Lighter Blue
    if (this.categoryRules['color-work-daily'].some(keyword => combinedText.includes(keyword))) {
      return 'color-work-daily';
    }
    
    // Work events (expanded list)
    if (this.workKeywords.some(keyword => combinedText.includes(keyword))) {
      return 'color-work';
    }
    
    // To-dos
    if (this.categoryRules['color-todo'].some(keyword => combinedText.includes(keyword))) {
      return 'color-todo';
    }
    
    // Everyday tasks
    if (this.categoryRules['color-everyday'].some(keyword => combinedText.includes(keyword)) ||
        eventType === 'band practice' || eventCategory === 'preparation') {
      return 'color-everyday';
    }
    
    // Travel
    if (this.categoryRules['color-travel'].some(keyword => combinedText.includes(keyword)) ||
        eventType === 'travel') {
      return 'color-travel';
    }
    
    // Celebrations
    if (this.categoryRules['color-celebration'].some(keyword => combinedText.includes(keyword)) ||
        eventType === 'celebration') {
      return 'color-celebration';
    }
    
    // Concerts
    if (this.categoryRules['color-concert'].some(keyword => combinedText.includes(keyword)) ||
        eventType === 'concert') {
      return 'color-concert';
    }
    
    // Meetings (if not already classified)
    if (eventType === 'meeting' || eventType === 'work') {
      return 'color-work';
    }
    
    return null; // No match found
  }
  
  /**
   * Classify event color using LLM (for edge cases)
   */
  async classifyWithLLM(eventTitle, eventType, eventCategory) {
    // Only use LLM if OpenAI is available
    if (!process.env.OPENAI_API_KEY) {
      return null;
    }
    
    try {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      
      const prompt = `Classify this calendar event into ONE of these color categories based on its title and context. Return ONLY the color class name, nothing else.

Event Title: "${eventTitle}"
Event Type: "${eventType || 'not specified'}"
Event Category: "${eventCategory || 'not specified'}"

Available color categories:
- color-doctor (medical appointments, doctor visits)
- color-todo (tasks, reminders, to-dos)
- color-everyday (practice, gym, workouts, everyday activities)
- color-work-daily (scrum, standup, daily meetings)
- color-work (work meetings, projects, business, planning, roadmapping, strategy)
- color-travel (travel, trips, flights)
- color-celebration (birthdays, parties, celebrations)
- color-concert (concerts, shows, music performances)
- color-general (everything else, default)

Return only the color class name:`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a calendar event classifier. Return ONLY the color class name, no explanation."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 50
      });

      const response = completion.choices[0].message.content.trim().toLowerCase();
      
      // Validate response is a valid color class
      const validColors = [
        'color-doctor', 'color-todo', 'color-everyday', 'color-work-daily',
        'color-work', 'color-travel', 'color-celebration', 'color-concert', 'color-general'
      ];
      
      if (validColors.includes(response)) {
        return response;
      }
      
      // If response contains a color class name, extract it
      const found = validColors.find(color => response.includes(color));
      if (found) {
        return found;
      }
      
      return 'color-general'; // Default fallback
    } catch (error) {
      console.error('Error in LLM color classification:', error);
      return null;
    }
  }
  
  /**
   * Clear cache (useful for testing or reset)
   */
  clearCache() {
    this.colorCache.clear();
  }
  
  /**
   * Get cache size (for monitoring)
   */
  getCacheSize() {
    return this.colorCache.size;
  }
}

// Export singleton instance
module.exports = new ColorClassificationService();

