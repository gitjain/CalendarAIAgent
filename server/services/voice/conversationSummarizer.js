const { OpenAI } = require('openai');

/**
 * Conversation Summarizer Service
 * Summarizes conversation history to maintain context while managing token costs
 */
class ConversationSummarizer {
  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  /**
   * Summarize a conversation history
   * @param {Array} messages - Array of {role, content} messages to summarize
   * @param {string} existingSummary - Optional existing summary to build upon
   * @returns {Promise<string>} Concise summary of the conversation
   */
  async summarizeConversation(messages, existingSummary = null) {
    if (!messages || messages.length === 0) {
      return existingSummary || '';
    }

    try {
      // Build the conversation text
      const conversationText = messages
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n');

      // Build the prompt
      const systemPrompt = `You are a conversation summarizer. Create a concise 2-3 sentence summary of the conversation that:
- Focuses on event details, decisions, and user preferences
- Includes specific details: dates, times, locations, names, activities
- Preserves context for future reference
- Is written in past tense
- Builds upon existing context if provided`;

      const userPrompt = existingSummary
        ? `Existing context: ${existingSummary}\n\nNew conversation:\n${conversationText}\n\nProvide an updated summary that combines the existing context with the new conversation.`
        : `Conversation:\n${conversationText}\n\nProvide a concise summary.`;

      console.log('🔄 [Summarizer] Generating summary for', messages.length, 'messages');

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 150 // Keep summaries concise
      });

      const summary = completion.choices[0].message.content.trim();
      
      console.log('✅ [Summarizer] Generated summary:', summary.substring(0, 100) + '...');
      
      return summary;
    } catch (error) {
      console.error('❌ [Summarizer] Error generating summary:', error.message);
      
      // Fallback: return existing summary or a basic concatenation
      if (existingSummary) {
        return existingSummary;
      }
      
      // Last resort: simple text summary
      const topics = messages
        .filter(msg => msg.role === 'user')
        .map(msg => msg.content.substring(0, 50))
        .join('; ');
      
      return `Discussed: ${topics}`;
    }
  }

  /**
   * Check if summarization is needed based on message count
   * @param {number} messageCount - Current number of messages in history
   * @param {number} lastSummarizedAt - Message count when last summarized
   * @returns {boolean} True if summarization should occur
   */
  shouldSummarize(messageCount, lastSummarizedAt = 0) {
    const EXCHANGES_BEFORE_SUMMARY = 4;
    const MESSAGES_PER_EXCHANGE = 2;
    const THRESHOLD = EXCHANGES_BEFORE_SUMMARY * MESSAGES_PER_EXCHANGE;

    // Summarize every 8 messages (4 exchanges)
    return messageCount >= THRESHOLD && (messageCount - lastSummarizedAt) >= THRESHOLD;
  }

  /**
   * Get the messages that should be summarized
   * @param {Array} allMessages - All messages in history
   * @param {number} lastSummarizedAt - Message count when last summarized
   * @returns {Object} {toSummarize, toKeep}
   */
  getMessagesToSummarize(allMessages, lastSummarizedAt = 0) {
    const MESSAGES_TO_KEEP = 8; // Keep last 4 exchanges

    if (allMessages.length <= MESSAGES_TO_KEEP) {
      return {
        toSummarize: [],
        toKeep: allMessages
      };
    }

    // Summarize everything except the last 8 messages
    const splitPoint = allMessages.length - MESSAGES_TO_KEEP;
    
    return {
      toSummarize: allMessages.slice(0, splitPoint),
      toKeep: allMessages.slice(splitPoint)
    };
  }
}

// Export singleton instance
module.exports = new ConversationSummarizer();

