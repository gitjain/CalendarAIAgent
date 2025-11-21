/**
 * Calendar Utilities
 * Shared utilities for calendar operations across the application
 */

/**
 * Find free time slots between events
 * @param {Array} events - Array of calendar events with date/endDate
 * @param {Date} startDate - Start of search window (default: now)
 * @param {Date} endDate - End of search window (default: now + daysToCheck)
 * @param {Object} options - Optional configuration
 * @returns {Array} Array of free slots with { startTime, endTime, duration, date }
 */
function findFreeSlots(events, startDate = null, endDate = null, options = {}) {
  const {
    minDuration = 120, // Minimum slot duration in minutes (default 2 hours)
    daysToCheck = 14   // Default days to check if endDate not provided
  } = options;

  const freeSlots = [];
  const now = startDate || new Date();
  const searchEndDate = endDate || (() => {
    const end = new Date(now);
    end.setDate(end.getDate() + daysToCheck);
    return end;
  })();

  // Normalize events to have consistent date/time format
  const normalizedEvents = events.map(event => {
    const date = new Date(event.date);
    const eventEndDate = event.endDate ? new Date(event.endDate) : new Date(date.getTime() + 60 * 60 * 1000); // Default 1 hour
    return {
      start: date,
      end: eventEndDate,
      title: event.title
    };
  }).filter(e => e.start && !isNaN(e.start.getTime()) && e.start >= now);

  // Sort events by start time
  normalizedEvents.sort((a, b) => a.start - b.start);

  // Start from now, find gaps between events
  let currentTime = new Date(now);
  currentTime.setMinutes(0, 0, 0); // Round to hour

  normalizedEvents.forEach(event => {
    // If there's a gap before this event
    if (currentTime < event.start) {
      const gapDuration = (event.start - currentTime) / (1000 * 60); // minutes
      
      // Only consider gaps of minimum duration
      if (gapDuration >= minDuration) {
        freeSlots.push({
          startTime: currentTime.toISOString(),
          endTime: event.start.toISOString(),
          duration: gapDuration,
          date: currentTime.toISOString().split('T')[0]
        });
      }
    }
    
    // Move current time to end of this event
    currentTime = new Date(event.end);
    // Round up to next hour for cleaner slots
    currentTime.setMinutes(0, 0, 0);
    currentTime.setHours(currentTime.getHours() + 1);
  });

  // Check for free slot at end of period
  if (currentTime < searchEndDate) {
    const gapDuration = (searchEndDate - currentTime) / (1000 * 60);
    if (gapDuration >= minDuration) {
      freeSlots.push({
        startTime: currentTime.toISOString(),
        endTime: searchEndDate.toISOString(),
        duration: gapDuration,
        date: currentTime.toISOString().split('T')[0]
      });
    }
  }

  return freeSlots;
}

module.exports = {
  findFreeSlots
};

