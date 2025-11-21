const { OpenAI } = require('openai');

/**
 * Wishlist Analyzer - Uses LLM to analyze wishlist items and match them to free time slots
 */
class WishlistAnalyzer {
  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  /**
   * Analyze wishlist item to estimate duration and requirements
   * @param {Object} wishlistItem - The wishlist item to analyze
   * @returns {Promise<Object>} Analysis with duration, requirements, etc.
   */
  async analyzeItem(wishlistItem) {
    try {
      const prompt = `Analyze this wishlist/activity item and provide structured information:

Item: "${wishlistItem.title}"
${wishlistItem.description ? `Description: "${wishlistItem.description}"` : ''}
${wishlistItem.location ? `Location: "${wishlistItem.location}"` : ''}
${wishlistItem.category ? `Category: "${wishlistItem.category}"` : ''}

Return a JSON object with:
{
  "estimatedDuration": <number in minutes>,
  "minDuration": <minimum time in minutes>,
  "maxDuration": <maximum time in minutes>,
  "requiresBooking": <true/false if needs advance booking>,
  "bestTimeOfDay": <"morning", "afternoon", "evening", or "any">,
  "bestDayOfWeek": <"weekday", "weekend", or "any">,
  "seasonality": <"outdoor", "indoor", or "any">,
  "travelTime": <estimated travel time in minutes if location specified>,
  "requirements": ["list", "of", "specific", "requirements"],
  "reasoning": "Brief explanation of duration estimate"
}

Examples:
- "Visit art museum" → ~2-3 hours (can be shortened to 1 hour minimum)
- "Take pottery class" → ~2 hours (requires booking)
- "Try new sushi restaurant" → ~1-1.5 hours
- "Learn guitar" → ~1 hour per session (recurring)
- "Go hiking" → ~3-4 hours (outdoor, good weather needed)
- "Read book at coffee shop" → ~1-2 hours (flexible)`;

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are an expert at estimating activity durations and requirements. Return only valid JSON."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" }
      });

      const analysis = JSON.parse(completion.choices[0].message.content);
      return analysis;
    } catch (error) {
      console.error('Error analyzing wishlist item:', error);
      // Fallback defaults
      return {
        estimatedDuration: 120, // 2 hours default
        minDuration: 60,
        maxDuration: 240,
        requiresBooking: false,
        bestTimeOfDay: "any",
        bestDayOfWeek: "any",
        seasonality: "any",
        travelTime: 0,
        requirements: [],
        reasoning: "Default estimate - could not analyze"
      };
    }
  }

  /**
   * Match wishlist items to free time slots
   * @param {Array} wishlistItems - Array of wishlist items
   * @param {Array} freeSlots - Array of free time slots { date, startTime, endTime, duration }
   * @returns {Promise<Array>} Array of matches with suggestions
   */
  async matchItemsToSlots(wishlistItems, freeSlots) {
    try {
      if (!wishlistItems.length || !freeSlots.length) {
        return [];
      }

      // First, analyze all wishlist items to get their durations
      const itemsWithAnalysis = await Promise.all(
        wishlistItems.map(async (item) => {
          const analysis = await this.analyzeItem(item);
          return {
            ...item,
            analysis
          };
        })
      );

      // Build prompt for matching
      const itemsSummary = itemsWithAnalysis.map((item, idx) => {
        const analysis = item.analysis;
        return `${idx + 1}. "${item.title}" - Estimated ${analysis.estimatedDuration} min (${analysis.minDuration}-${analysis.maxDuration} min range). ${item.location ? `Location: ${item.location}` : ''} Priority: ${item.priority}`;
      }).join('\n');

      const slotsSummary = freeSlots.map((slot, idx) => {
        const slotDuration = slot.duration || (new Date(slot.endTime) - new Date(slot.startTime)) / (1000 * 60);
        return `${idx + 1}. ${new Date(slot.startTime).toLocaleDateString()} from ${new Date(slot.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to ${new Date(slot.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${Math.round(slotDuration)} minutes available)`;
      }).join('\n');

      const prompt = `Match wishlist items to available free time slots. Consider:
1. Duration fits (item duration <= slot duration)
2. Time of day preference
3. Day of week preference  
4. Travel time if location specified
5. Priority of items
6. Practicality (e.g., don't suggest outdoor activities in bad weather without checking)

Wishlist Items:
${itemsSummary}

Available Free Slots:
${slotsSummary}

Return JSON array of matches (max 3 best matches):
[
  {
    "itemId": <wishlist item ID>,
    "slotIndex": <slot index (0-based)>,
    "confidence": <0.0-1.0>,
    "reasoning": "Why this is a good match",
    "suggestedStartTime": "ISO datetime",
    "travelTimeNeeded": <minutes if location specified>
  }
]

Only include matches where item duration fits in slot duration. Prioritize higher priority items and better time matches.`;

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are an expert at matching activities to available time slots. Return only valid JSON array."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.4,
        max_tokens: 800
      });

      const responseContent = completion.choices[0].message.content;
      let matches = [];
      
      try {
        // Try to parse JSON (might be wrapped in markdown)
        const jsonMatch = responseContent.match(/\[[\s\S]*\]/);
        matches = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseContent);
      } catch (parseError) {
        console.error('Error parsing LLM response:', parseError);
        // Fallback: simple duration-based matching
        matches = this._simpleMatch(itemsWithAnalysis, freeSlots);
      }

      // Enrich matches with full item and slot data
      return matches.map(match => ({
        ...match,
        item: itemsWithAnalysis.find(item => item.id === match.itemId),
        slot: freeSlots[match.slotIndex],
        analysis: itemsWithAnalysis.find(item => item.id === match.itemId)?.analysis
      })).filter(match => match.item && match.slot); // Remove invalid matches

    } catch (error) {
      console.error('Error matching wishlist items:', error);
      return [];
    }
  }

  /**
   * Fallback simple matching based on duration
   */
  _simpleMatch(itemsWithAnalysis, freeSlots) {
    const matches = [];
    
    itemsWithAnalysis.forEach((item, itemIdx) => {
      const duration = item.analysis?.estimatedDuration || 120;
      
      freeSlots.forEach((slot, slotIdx) => {
        const slotDuration = slot.duration || (new Date(slot.endTime) - new Date(slot.startTime)) / (1000 * 60);
        
        if (duration <= slotDuration) {
          matches.push({
            itemId: item.id,
            slotIndex: slotIdx,
            confidence: 0.7,
            reasoning: `Duration fits (${duration} min in ${Math.round(slotDuration)} min slot)`,
            suggestedStartTime: slot.startTime
          });
        }
      });
    });

    // Sort by confidence and priority, return top 3
    return matches
      .sort((a, b) => {
        const itemA = itemsWithAnalysis.find(item => item.id === a.itemId);
        const itemB = itemsWithAnalysis.find(item => item.id === b.itemId);
        const priorityWeight = { high: 3, medium: 2, low: 1 };
        const priorityA = priorityWeight[itemA?.priority] || 2;
        const priorityB = priorityWeight[itemB?.priority] || 2;
        return (b.confidence * priorityB) - (a.confidence * priorityA);
      })
      .slice(0, 3);
  }

  /**
   * Generate suggestion message for a matched wishlist item
   */
  async generateSuggestionMessage(match) {
    try {
      const item = match.item;
      const slot = match.slot;
      const slotDate = new Date(slot.startTime);
      
      const prompt = `Generate a friendly, natural suggestion message for scheduling a wishlist item.

Item: "${item.title}"
Available time: ${slotDate.toLocaleDateString()} from ${slotDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
Duration needed: ${match.analysis?.estimatedDuration || 120} minutes
${match.reasoning ? `Reasoning: ${match.reasoning}` : ''}

Generate a brief, friendly message (1-2 sentences max) suggesting this activity for this time slot. Be conversational and encouraging.`;

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a friendly personal assistant. Generate natural, conversational suggestions."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 150
      });

      return completion.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error generating suggestion message:', error);
      const slotDate = new Date(match.slot.startTime);
      return `Want to schedule "${match.item.title}" on ${slotDate.toLocaleDateString()} at ${slotDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}?`;
    }
  }
}

module.exports = WishlistAnalyzer;

