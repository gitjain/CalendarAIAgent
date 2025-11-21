const express = require('express');
const router = express.Router();
const wishlistStore = require('../services/wishlistStore');
const WishlistAnalyzer = require('../services/wishlistAnalyzer');
const calendarConflictService = require('../services/calendarConflictService');
const { google } = require('googleapis');
const crypto = require('crypto');
const { findFreeSlots } = require('../services/calendarUtils');

// Google OAuth2 client
let oauth2Client;

// Initialize OAuth2 client
function initOAuth2Client() {
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5001/api/google-calendar/callback'
    );
  }
  return oauth2Client;
}

let wishlistAnalyzer;
try {
  wishlistAnalyzer = new WishlistAnalyzer();
  console.log('✅ Wishlist Analyzer initialized successfully');
} catch (error) {
  console.warn('⚠️ Wishlist Analyzer initialization failed:', error.message);
}

/**
 * Get all active wishlist items (auto-cleanup past items)
 */
router.get('/items', async (req, res) => {
  try {
    // Cleanup past-dated items
    wishlistStore.cleanup();
    
    // Get active items only
    const items = wishlistStore.getActiveItems();
    
    // Also check if any scheduled items are already in calendar and remove them
    // This is a simple check - in production you might want to cross-reference with actual calendar
    const activeItems = items;
    
    res.json({
      success: true,
      items: activeItems
    });
  } catch (error) {
    console.error('Error fetching wishlist items:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch wishlist items'
    });
  }
});

/**
 * Add wishlist item
 */
router.post('/items', async (req, res) => {
  try {
    const { title, description, date, time, priority, location, category } = req.body;

    if (!title) {
      return res.status(400).json({
        success: false,
        error: 'Title is required'
      });
    }

    const item = wishlistStore.addItem({
      title,
      description,
      date,
      time,
      priority: priority || 'medium',
      location,
      category,
      source: 'manual'
    });

    res.json({
      success: true,
      item: item
    });
  } catch (error) {
    console.error('Error adding wishlist item:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to add wishlist item'
    });
  }
});

/**
 * Update wishlist item
 */
router.put('/items/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, location, date, time, priority } = req.body;

    const updated = wishlistStore.updateItem(id, {
      title,
      description,
      location,
      date,
      time,
      priority
    });

    if (updated) {
      res.json({
        success: true,
        item: updated,
        message: 'Wishlist item updated'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Wishlist item not found'
      });
    }
  } catch (error) {
    console.error('Error updating wishlist item:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update wishlist item'
    });
  }
});

/**
 * Delete wishlist item
 */
router.delete('/items/:id', (req, res) => {
  try {
    const { id } = req.params;
    const deleted = wishlistStore.deleteItem(id);

    if (deleted) {
      res.json({
        success: true,
        message: 'Wishlist item deleted'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Wishlist item not found'
      });
    }
  } catch (error) {
    console.error('Error deleting wishlist item:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete wishlist item'
    });
  }
});

/**
 * Find free slots and match wishlist items
 */
router.post('/find-time', async (req, res) => {
  try {
    const { events, daysToCheck = 14 } = req.body;

    if (!events || !Array.isArray(events)) {
      return res.status(400).json({
        success: false,
        error: 'Events array is required'
      });
    }

    if (!wishlistAnalyzer) {
      return res.status(503).json({
        success: false,
        error: 'Wishlist analyzer not available'
      });
    }

    // Get unscheduled wishlist items
    const wishlistItems = wishlistStore.getUnscheduledItems();
    
    if (wishlistItems.length === 0) {
      return res.json({
        success: true,
        matches: [],
        message: 'No unscheduled wishlist items to match'
      });
    }

    // Find free slots (2+ hours) in the next N days
    const freeSlots = findFreeSlots(events, daysToCheck);
    
    if (freeSlots.length === 0) {
      return res.json({
        success: true,
        matches: [],
        message: 'No free slots found (2+ hours required)'
      });
    }

    // Match wishlist items to free slots using LLM
    const matches = await wishlistAnalyzer.matchItemsToSlots(wishlistItems, freeSlots);

    // Generate suggestion messages for each match
    const matchesWithMessages = await Promise.all(
      matches.map(async (match) => {
        const message = await wishlistAnalyzer.generateSuggestionMessage(match);
        return {
          ...match,
          suggestionMessage: message
        };
      })
    );

    res.json({
      success: true,
      matches: matchesWithMessages,
      freeSlotsCount: freeSlots.length,
      wishlistItemsCount: wishlistItems.length
    });

  } catch (error) {
    console.error('Error finding time for wishlist:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to find time for wishlist items'
    });
  }
});

router.post('/items/:id/suggestions', async (req, res) => {
  try {
    if (!wishlistAnalyzer) {
      return res.status(503).json({
        success: false,
        error: 'Wishlist analyzer not available'
      });
    }

    const { id } = req.params;
    const tokens = req.session?.tokens;

    if (!tokens || !tokens.access_token) {
      return res.status(401).json({
        success: false,
        error: 'Connect Google Calendar to get scheduling suggestions'
      });
    }

    const item = wishlistStore.getItemById(id);
    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Wishlist item not found'
      });
    }

    const oauth2Client = initOAuth2Client();
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const now = new Date();
    const oneWeekLater = new Date(now);
    oneWeekLater.setDate(oneWeekLater.getDate() + 7);

    const events = await fetchCalendarEvents(calendar, now, oneWeekLater);
    const normalizedEvents = events.map(evt => normalizeGoogleEvent(evt)).filter(Boolean);

    const freeSlots = findFreeSlots(normalizedEvents, 7);

    if (!freeSlots.length) {
      return res.json({
        success: true,
        suggestions: [],
        message: 'No free time slots in the next week'
      });
    }

    const analysis = await wishlistAnalyzer.analyzeItem(item);
    const suggestions = await buildSuggestionsForItem({ item, analysis, freeSlots });

    res.json({
      success: true,
      suggestions: suggestions
    });
  } catch (error) {
    console.error('Error generating wishlist suggestions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate suggestions'
    });
  }
});

async function fetchCalendarEvents(calendar, timeMin, timeMax) {
  const items = [];
  let pageToken;

  do {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      pageToken
    });

    if (response.data.items) {
      items.push(...response.data.items);
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return items;
}

function normalizeGoogleEvent(event) {
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;

  if (!start || !end) {
    return null;
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return null;
  }

  // All-day events have an end date equal to next day, keep as-is
  return {
    date: startDate.toISOString(),
    endDate: endDate.toISOString(),
    title: event.summary || 'Calendar Event'
  };
}

async function buildSuggestionsForItem({ item, analysis, freeSlots }) {
  const estimatedDuration = analysis?.estimatedDuration || 120;
  const minDuration = analysis?.minDuration || Math.min(estimatedDuration, 60);
  const bestTimeOfDay = (analysis?.bestTimeOfDay || 'any').toLowerCase();
  const bestDayOfWeek = (analysis?.bestDayOfWeek || 'any').toLowerCase();

  const slotsWithScores = freeSlots
    .map(slot => scoreSlot(slot, { estimatedDuration, minDuration, bestTimeOfDay, bestDayOfWeek }))
    .filter(slot => slot && slot.duration >= minDuration);

  if (!slotsWithScores.length) {
    return [];
  }

  const topSlots = slotsWithScores
    .sort((a, b) => b.score - a.score || (new Date(a.startTime) - new Date(b.startTime)))
    .slice(0, 3);

  const suggestions = [];
  for (const slot of topSlots) {
    const suggestionId = crypto.createHash('sha1').update(`${item.id}-${slot.startTime}`).digest('hex');
    const match = {
      item,
      slot: {
        startTime: slot.startTime,
        endTime: slot.endTime,
        duration: slot.availableDuration
      },
      analysis,
      reasoning: slot.reasoning
    };

    const message = await wishlistAnalyzer.generateSuggestionMessage(match);

    suggestions.push({
      id: suggestionId,
      startTime: slot.startTime,
      endTime: slot.endTime,
      durationMinutes: slot.scheduledDuration,
      confidence: Math.min(0.95, 0.55 + slot.score / 10),
      reasoning: slot.reasoning,
      message
    });
  }

  return suggestions;
}

function scoreSlot(slot, { estimatedDuration, minDuration, bestTimeOfDay, bestDayOfWeek }) {
  const slotStart = new Date(slot.startTime);
  const slotEnd = slot.endTime ? new Date(slot.endTime) : null;

  if (Number.isNaN(slotStart.getTime())) {
    return null;
  }

  const slotDuration = slotEnd ? (slotEnd - slotStart) / (1000 * 60) : slot.duration;
  if (!slotDuration || slotDuration < minDuration) {
    return null;
  }

  const scheduledEnd = slotEnd && slotDuration >= estimatedDuration
    ? new Date(slotStart.getTime() + estimatedDuration * 60000)
    : slotEnd || new Date(slotStart.getTime() + Math.min(slotDuration, estimatedDuration) * 60000);

  const availableDuration = slotEnd ? (slotEnd - slotStart) / (1000 * 60) : slot.duration;
  const scheduledDuration = Math.min(estimatedDuration, availableDuration);

  let score = 5; // base score
  const reasoningParts = [];

  reasoningParts.push(`Fits a ${Math.round(scheduledDuration)} minute window`);

  // Time of day preference
  if (bestTimeOfDay !== 'any') {
    const hour = slotStart.getHours();
    const matchesTime =
      (bestTimeOfDay === 'morning' && hour >= 6 && hour < 12) ||
      (bestTimeOfDay === 'afternoon' && hour >= 12 && hour < 17) ||
      (bestTimeOfDay === 'evening' && hour >= 17 && hour < 22);
    if (matchesTime) {
      score += 2;
      reasoningParts.push(`Matches preferred ${bestTimeOfDay} time`);
    }
  }

  // Day of week preference
  if (bestDayOfWeek !== 'any') {
    const day = slotStart.getDay(); // 0 Sunday
    const isWeekend = day === 0 || day === 6;
    const preferredWeekend = bestDayOfWeek === 'weekend';
    if ((preferredWeekend && isWeekend) || (!preferredWeekend && !isWeekend)) {
      score += 1.5;
      reasoningParts.push(`Falls on a preferred ${bestDayOfWeek}`);
    }
  }

  // Favor closer dates
  const daysAway = Math.max(0, Math.floor((slotStart - new Date()) / (1000 * 60 * 60 * 24)));
  score += Math.max(0, (7 - daysAway) * 0.3);

  return {
    startTime: slotStart.toISOString(),
    endTime: scheduledEnd.toISOString(),
    scheduledDuration,
    availableDuration,
    score,
    reasoning: reasoningParts.join('. ')
  };
}

/**
 * Analyze a single wishlist item for duration estimation
 */
router.post('/analyze-item', async (req, res) => {
  try {
    const { item } = req.body;

    if (!item || !item.title) {
      return res.status(400).json({
        success: false,
        error: 'Item with title is required'
      });
    }

    if (!wishlistAnalyzer) {
      return res.status(503).json({
        success: false,
        error: 'Wishlist analyzer not available'
      });
    }

    const analysis = await wishlistAnalyzer.analyzeItem(item);

    res.json({
      success: true,
      analysis: analysis
    });

  } catch (error) {
    console.error('Error analyzing wishlist item:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to analyze wishlist item'
    });
  }
});

module.exports = router;

