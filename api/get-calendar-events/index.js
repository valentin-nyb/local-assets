const { google } = require('googleapis');
const path = require('path');

// In AWS Lambda, configure this as an environment variable.
const { CALENDAR_ID } = process.env;

// The name of your service account key file, bundled with the Lambda.
const KEY_FILE_PATH = path.join(__dirname, 'service-account-key.json');
const EVENT_PREFIX = 'RECORD:';

// Initialize the client outside the handler.
const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE_PATH,
  scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
});
const calendar = google.calendar({ version: 'v3', auth });


exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://local-assets.com",
    "Access-Control-Allow-Methods": "GET",
  };

  try {
    const now = new Date();
    // Look for events from 15 minutes ago to 2 hours from now for resilience.
    const timeMin = new Date(now.getTime() - 15 * 60000).toISOString();
    const timeMax = new Date(now.getTime() + 120 * 60000).toISOString();

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      q: EVENT_PREFIX, // Use Google's query parameter to filter for recording events.
    });

    const events = response.data.items || [];

    return {
      statusCode: 200,
      headers: corsHeaders,
      // We only need to return a subset of the event data to the client.
      body: JSON.stringify(events.map(e => ({
          id: e.id,
          summary: e.summary,
          start: e.start,
          end: e.end
      }))),
    };
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Could not fetch calendar events.' }),
    };
  }
};
