const express = require('express');
const router = express.Router();
const { google } = require('googleapis');

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

// Generate authorization URL
router.get('/auth-url', (req, res) => {
  try {
    const oauth2Client = initOAuth2Client();
    
    const scopes = [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/drive.readonly' // For Google Docs access (Phase 1)
    ];
    
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent'
    });
    
    res.json({
      success: true,
      authUrl: authUrl
    });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Handle OAuth callback
router.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}?error=no_code`);
    }

    const oauth2Client = initOAuth2Client();

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfoResponse = await oauth2.userinfo.get();
    const userInfo = userInfoResponse.data;

    // Store tokens and user info in session (expires in 3 days)
    req.session.tokens = tokens;
    req.session.userInfo = {
      id: userInfo.id,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      verified_email: userInfo.verified_email
    };

    // Save session and redirect
    req.session.save((err) => {
      if (err) {
        console.error('Error saving session:', err);
        return res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}?error=session_failed`);
      }

      // Redirect back to client with success indicator
      res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}?auth=success`);
    });
  } catch (error) {
    console.error('Error in OAuth callback:', error);
    res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}?error=auth_failed`);
  }
});

// Fetch calendar events
router.post('/events', async (req, res) => {
  try {
    const { tokens } = req.body;
    
    if (!tokens) {
      return res.status(400).json({
        success: false,
        error: 'No authentication tokens provided'
      });
    }
    
    const oauth2Client = initOAuth2Client();
    oauth2Client.setCredentials(tokens);
    
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Fetch all future events starting today (with pagination)
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0); // Begin at midnight local time

    let allEvents = [];
    let nextPageToken = null;

    do {
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: startOfToday.toISOString(),
        maxResults: 250,
        singleEvents: true,
        orderBy: 'startTime',
        pageToken: nextPageToken || undefined
      });

      const items = response.data.items || [];
      allEvents = allEvents.concat(items);
      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    console.log(`📆 Retrieved ${allEvents.length} Google Calendar events starting ${startOfToday.toISOString().split('T')[0]}`);

    // Process events - keep all instances of recurring events
    const events = allEvents
      .filter(event => {
        // Keep non-recurring events
        if (!event.recurrence && !event.recurringEventId) {
          return true;
        }

        // For recurring events with recurringEventId (instances of recurring events)
        // Keep ALL instances now instead of just the first one
        if (event.recurringEventId) {
          return true; // Keep all instances
        }

        // For events with recurrence rules (parent recurring events)
        // Skip the parent since we're already showing individual instances
        if (event.recurrence) {
          return false; // Don't show parent recurring event, show instances instead
        }

        return false;
      })
      .map(event => {
        const start = event.start?.dateTime || event.start?.date;
        const end = event.end?.dateTime || event.end?.date;
        
        // Determine event type based on title and description
        // For checklist events, ensure the title is properly extracted
        let title = event.summary || 'Untitled Event';
        
        // If title starts with 📋 but is just the emoji or placeholder, extract from description
        if (event.extendedProperties?.private?.isAIGenerated === 'true' &&
            (title === '📋' || title === '📋 ' || title.includes('Prep:') || title.includes('Prep for'))) {
          // Try to extract task title from description
          const descMatch = event.description?.match(/^📋\s*(.+?)(?:\n|$)/);
          if (descMatch) {
            title = `📋 ${descMatch[1]}`;
          }
        }
        
        const description = event.description || '';
        
        let type = 'general';
        const titleLower = title.toLowerCase();
        const descLower = description.toLowerCase();
        
        if (titleLower.includes('meeting') || descLower.includes('meeting') || 
            titleLower.includes('call') || descLower.includes('call')) {
          type = 'meeting';
        } else if (titleLower.includes('travel') || titleLower.includes('trip') || 
                   titleLower.includes('flight') || titleLower.includes('train')) {
          type = 'travel';
        } else if (titleLower.includes('practice') || titleLower.includes('rehearsal') || 
                   titleLower.includes('training') || titleLower.includes('workout')) {
          // Check practice BEFORE music to avoid misclassifying "music band practice" as concert
          type = 'band practice';
        } else if (titleLower.includes('concert') || titleLower.includes('show') || 
                   (titleLower.includes('music') && !titleLower.includes('practice'))) {
          // Only classify as concert if it's music-related but NOT practice
          type = 'concert';
        } else if (titleLower.includes('pickup') || titleLower.includes('delivery') || 
                   titleLower.includes('appointment') || titleLower.includes('doctor')) {
          type = 'pickup';
        } else if (titleLower.includes('birthday') || titleLower.includes('anniversary') || 
                   titleLower.includes('party') || titleLower.includes('celebration')) {
          type = 'celebration';
        } else if (titleLower.includes('deadline') || titleLower.includes('due') || 
                   titleLower.includes('project') || titleLower.includes('work')) {
          type = 'work';
        }
        
        // Check if this event was created by voice assistant
        const isAIGenerated = event.extendedProperties?.private?.isAIGenerated === 'true' ||
                             event.extendedProperties?.private?.createdByVoice === 'true' ||
                             event.extendedProperties?.private?.aiGenerated === 'true';

        // Check if this event has been analyzed
        const isAnalyzed = event.extendedProperties?.private?.isAnalyzed === 'true';

        // Debug logging for AI-generated events
        if (isAIGenerated) {
          console.log(`🤖 Found AI-generated event: ${title} (Extended props: ${JSON.stringify(event.extendedProperties)})`);
        }

        // Debug logging for analyzed events
        if (isAnalyzed) {
          console.log(`✓ Found analyzed event: ${title}`);
        }

        // Get linkedTaskCount from extendedProperties
        const linkedTaskCount = event.extendedProperties?.private?.tasksCount 
          ? parseInt(event.extendedProperties.private.tasksCount, 10) 
          : 0;

        if (isAnalyzed || linkedTaskCount > 0) {
          console.log(`📊 [Google Calendar Event] ${title}:`, {
            isAnalyzed,
            linkedTaskCount,
            extendedProps: event.extendedProperties?.private
          });
        }

        return {
          id: event.id || `google-${Date.now()}-${Math.random()}`,
          title: title,
          type: type,
          date: start,
          endDate: end,
          description: description,
          location: event.location || '',
          isAnalyzed: isAnalyzed,
          isAIGenerated: isAIGenerated,
          linkedTaskCount: linkedTaskCount,
          originalEventId: event.extendedProperties?.private?.originalEventId,
          originalEventTitle: event.extendedProperties?.private?.originalEventTitle,
          source: 'google',
          colorId: event.colorId || null, // Include Google Calendar colorId
          attendees: event.attendees ? event.attendees.length : 0,
          allDay: !event.start?.dateTime, // true if only date is provided
          isRecurring: !!(event.recurrence || event.recurringEventId)
        };
      });
    
    res.json({
      success: true,
      events: events
    });
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get user information
router.post('/user-info', async (req, res) => {
  try {
    const { tokens } = req.body;
    
    if (!tokens) {
      return res.status(400).json({
        success: false,
        error: 'No authentication tokens provided'
      });
    }
    
    const oauth2Client = initOAuth2Client();
    oauth2Client.setCredentials(tokens);
    
    // Get user info from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    
    res.json({
      success: true,
      user: {
        id: userInfo.data.id,
        email: userInfo.data.email,
        name: userInfo.data.name,
        picture: userInfo.data.picture,
        verified_email: userInfo.data.verified_email
      }
    });
  } catch (error) {
    console.error('Error fetching user info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Revoke tokens (sign out)
router.post('/revoke', async (req, res) => {
  try {
    const { tokens } = req.body;
    
    if (!tokens || !tokens.access_token) {
      return res.status(400).json({
        success: false,
        error: 'No access token provided'
      });
    }
    
    const oauth2Client = initOAuth2Client();
    oauth2Client.setCredentials(tokens);
    
    // Revoke the token
    await oauth2Client.revokeToken(tokens.access_token);
    
    res.json({
      success: true,
      message: 'Tokens revoked successfully'
    });
  } catch (error) {
    console.error('Error revoking tokens:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Refresh access token
router.post('/refresh-token', async (req, res) => {
  try {
    const { tokens } = req.body;

    if (!tokens || !tokens.refresh_token) {
      return res.status(400).json({
        success: false,
        error: 'No refresh token provided'
      });
    }

    const oauth2Client = initOAuth2Client();
    oauth2Client.setCredentials(tokens);

    const newTokens = await oauth2Client.refreshAccessToken();

    // Update session with new tokens
    if (req.session) {
      req.session.tokens = newTokens.credentials;
    }

    res.json({
      success: true,
      tokens: newTokens.credentials
    });
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Check session status
router.get('/session', (req, res) => {
  try {
    if (req.session && req.session.tokens && req.session.userInfo) {
      res.json({
        success: true,
        isAuthenticated: true,
        userInfo: req.session.userInfo,
        tokens: req.session.tokens
      });
    } else {
      res.json({
        success: true,
        isAuthenticated: false
      });
    }
  } catch (error) {
    console.error('Error checking session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Logout and destroy session
router.post('/logout', async (req, res) => {
  try {
    // Revoke tokens if available
    if (req.session && req.session.tokens) {
      try {
        const oauth2Client = initOAuth2Client();
        oauth2Client.setCredentials(req.session.tokens);
        await oauth2Client.revokeToken(req.session.tokens.access_token);
      } catch (error) {
        console.warn('Failed to revoke tokens:', error);
      }
    }

    // Destroy session
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destroying session:', err);
        return res.status(500).json({
          success: false,
          error: 'Failed to logout'
        });
      }

      res.clearCookie('connect.sid');
      res.json({
        success: true,
        message: 'Logged out successfully'
      });
    });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
