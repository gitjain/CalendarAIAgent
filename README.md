# Calendar Events App

A React web application with an Express.js server that displays calendar events. The app supports both Google Calendar integration and mock data, with AI-powered event analysis and smart preparation suggestions.

## Features

### Core Features
- **Google Calendar Integration**: Connect your Google account to fetch real calendar events
- **Fallback to Sample Data**: Use built-in sample events if you prefer not to connect Google Calendar
- **React Frontend**: Clean, responsive UI with modern design
- **Express.js Backend**: RESTful API serving calendar data
- **AI Event Analysis**: OpenAI-powered agent that analyzes events and suggests preparation tasks
- **Smart Event Classification**: Automatically categorizes events (travel, meetings, concerts, etc.)

### AI-Powered Analysis
- **Agentic Event Analysis**: Modular AI agent with tool integration
- **Context-Aware Checklists**: Event-specific preparation recommendations with:
  - Prioritized task lists
  - Time estimates for each task
  - Preparation timelines
  - Pro tips and advice
- **Document Integration**: Automatically fetches and summarizes Google Docs linked in event descriptions
- **Weather Integration**: Outdoor event suggestions based on weather forecasts

### Meal Planning (NEW ⭐)
- **Automatic Detection**: Recognizes meal prep events (keywords: meal, lunch, dinner + prep)
- **MCP Integration**: Uses official Spoonacular MCP server for standardized API access
- **User Preferences**: Customizable meal plans with:
  - Number of days (1-7)
  - Number of people
  - Dietary restrictions (vegetarian, vegan, keto, paleo, etc.)
  - Target calories
  - Food exclusions
- **Dual-Source Generation**:
  - **Primary**: Spoonacular API via official MCP server (recipes, ingredients, nutrition)
  - **Fallback**: AI-generated meal plans when Spoonacular unavailable
- **Rich Display**: Inline meal cards with images, nutrition info, and recipe links
- **Smart Integration**: Meal plans integrated into event preparation checklists

### Task Management
- **Task Scheduling**: Add AI-generated tasks directly to Google Calendar
- **Task Tracking**: Server-side cache tracks remaining unscheduled tasks
- **Metadata Sync**: Tasks linked to original events via Google Calendar extended properties
- **Smart Hydration**: Shows remaining tasks when re-opening analyzed events

### Voice Assistant
- **Voice Commands**: Create, delete, and manage events via voice
- **Whisper Integration**: OpenAI Whisper for accurate speech-to-text
- **Follow-up Questions**: Interactive conversation flow for event details
- **Wishlist Management**: Add items to wishlist via voice

### Wishlist & Scheduling
- **Wishlist Items**: Track activities you want to schedule
- **Smart Matching**: AI matches wishlist items to free calendar slots
- **Time Suggestions**: Finds optimal 2+ hour gaps in your schedule
- **One-Click Scheduling**: Add matched items directly to calendar

### Additional Features
- **Responsive Design**: Mobile-friendly layout
- **Error Handling**: Graceful error handling for server connectivity
- **Loading States**: Visual feedback during data fetching
- **Easy Authentication**: Simple Google OAuth integration with option to skip
- **Uber Integration**: Mock Uber booking for transportation tasks

## Project Structure

```
CalendarAIAgent/
├── client/                 # React frontend
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   │   ├── CalendarEvents.js    # Main calendar view
│   │   │   ├── EventAnalysis.js     # AI analysis panel
│   │   │   ├── VoiceAssistant.js    # Voice commands
│   │   │   ├── Wishlist.js          # Wishlist management
│   │   │   └── GoogleAuth.js        # OAuth flow
│   │   ├── App.js
│   │   ├── App.css
│   │   ├── index.js
│   │   └── index.css
│   └── package.json
├── server/                 # Express.js backend
│   ├── server.js           # Main server & routes
│   ├── eventAnalyzer.js    # AI event analysis orchestrator
│   ├── routes/
│   │   ├── voice.js        # Voice endpoints
│   │   ├── googleCalendar.js  # Google Calendar API
│   │   └── wishlist.js     # Wishlist endpoints
│   └── services/
│       ├── eventAgent.js   # Agentic analysis with meal planning
│       ├── mcpMealPlanningClient.js  # Spoonacular MCP client
│       ├── eventsStore.js  # Event storage
│       ├── wishlistStore.js  # Wishlist storage
│       ├── taskCache.js    # Task tracking
│       └── voice/          # Voice adapters
├── package.json           # Root package.json
├── ARCHITECTURE.md        # System architecture documentation
└── README.md
```

## Getting Started

### Prerequisites

- Node.js (version 14 or higher)
- npm
- OpenAI API key (for AI event analysis feature)
- Spoonacular API key (optional, for meal planning - falls back to AI if not available)

### Installation

1. **Clone and install dependencies:**
   ```bash
   npm install
   npm run install-client
   ```
   Or install all at once:
   ```bash
   npm run install-all
   ```

2. **Set up Environment Variables:**
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Get your OpenAI API key from [OpenAI Platform](https://platform.openai.com/api-keys)
   - (Optional) Get Spoonacular API key from [Spoonacular](https://spoonacular.com/food-api)
   - Edit `.env` file and add your keys:
     ```
     OPENAI_API_KEY=your_actual_api_key_here
     SPOONACULAR_API_KEY=your_spoonacular_key_here  # Optional
     ```

3. **Install Spoonacular MCP Server (Optional - for Meal Planning):**
   ```bash
   npm install -g spoonacular-mcp
   ```
   This installs the official Spoonacular MCP server globally, enabling meal planning features.

### Running the Application

#### Development Mode (Recommended)

Run both server and client concurrently:
```bash
npm run dev
```

This will start:
- Express server on `http://localhost:5001`
- React client on `http://localhost:3000`

#### Individual Components

**Server only:**
```bash
npm run server
```

**Client only:**
```bash
npm run client
```

**Production mode:**
```bash
npm start
```

## API Endpoints

### Calendar & Events
- `GET /api/calendar/events` - Get all calendar events (Google or mock)
- `POST /api/analyze-event` - Analyze event and generate checklist
- `POST /api/add-ai-tasks` - Add AI-generated tasks to calendar
- `DELETE /api/calendar/events/:eventId` - Delete event
- `GET /api/event-status/:eventId` - Get analysis metadata for event

### Meal Planning
- `POST /api/generate-meal-plan` - Generate meal plan with user preferences
  - Uses official Spoonacular MCP server
  - Falls back to AI-generated meal plan if unavailable
  - Returns structured meal plan with recipes, images, and nutrition data

### Voice Assistant
- `POST /api/voice/transcribe` - Convert audio to text (Whisper)
- `POST /api/voice/process` - Parse voice command and extract intent
- `POST /api/voice/create-event` - Create event from voice
- `POST /api/voice/add-to-wishlist` - Add wishlist item via voice

### Wishlist
- `GET /api/wishlist/items` - Get all wishlist items
- `POST /api/wishlist/items` - Add wishlist item
- `DELETE /api/wishlist/items/:id` - Delete wishlist item
- `POST /api/wishlist/find-time` - Find free slots and match items

### Google Calendar
- `GET /api/google-calendar/auth` - Initiate OAuth flow
- `GET /api/google-calendar/callback` - OAuth callback
- `POST /api/google-calendar/events` - Fetch Google Calendar events
- `POST /api/google-calendar/disconnect` - Disconnect Google account

### Utility
- `GET /api/health` - Health check endpoint
- `GET /api/debug/event/:eventId` - Debug event metadata (development)

## Mock Data

The application includes 10 pre-configured events:

1. **Travel Events**: Business trips, vacations
2. **Concert Events**: Rock concerts, jazz performances, classical music
3. **Band Practice**: Weekly rehearsals and new song sessions  
4. **Pickup Events**: Airport pickups, school pickups

## Technologies Used

### Frontend
- **React 18**: Modern UI with hooks and functional components
- **Axios**: HTTP client for API calls
- **Web Speech API**: Browser-native speech recognition and synthesis
- **CSS3**: Custom responsive styling

### Backend
- **Node.js + Express.js**: RESTful API server
- **OpenAI API**: GPT-3.5-turbo for analysis, Whisper for transcription
- **Google Calendar API**: OAuth2 authentication and event sync
- **Google Docs API**: Document fetching and summarization
- **Spoonacular API**: Meal planning and nutrition data
- **Spoonacular MCP Server**: Official MCP integration for standardized API access

### Development
- **Concurrently**: Run multiple processes
- **Nodemon**: Auto-restart on file changes

## OpenAI Integration

The application uses OpenAI's GPT-3.5-turbo model to analyze calendar events and provide intelligent preparation suggestions. 

### Setup Required:
1. Get an API key from [OpenAI Platform](https://platform.openai.com/api-keys)
2. Set the `OPENAI_API_KEY` environment variable in your `.env` file
3. The server will automatically detect the API key and enable AI analysis

### Without OpenAI Key:
- The app will still function normally for viewing calendar events
- AI analysis feature will show an error message requesting API key setup
- No mock data or fallback responses are provided

## Google Calendar Setup

For Google Calendar integration, see [GOOGLE_CALENDAR_SETUP.md](GOOGLE_CALENDAR_SETUP.md) for detailed setup instructions.

### Quick Setup:
1. Get Google API credentials from [Google Cloud Console](https://console.cloud.google.com/)
2. Create a `.env` file in the `client` directory with your credentials
3. Install dependencies: `npm install` (in client directory)
4. Run the app: `npm start`

## Key Features in Detail

### Meal Planning System
The meal planning feature uses the Model Context Protocol (MCP) for standardized integration:

1. **Spoonacular MCP Server (Primary)**:
   - Official MCP-compliant server (`spoonacular-mcp` npm package)
   - Professional recipes with detailed instructions
   - Accurate nutritional information
   - Dietary restriction support
   - Standardized JSON-RPC 2.0 communication
   - Ingredient lists and shopping guidance

2. **AI Fallback (Secondary)**:
   - Activates when Spoonacular is unavailable
   - Uses user preferences to generate meal plans
   - Provides similar structure to Spoonacular output
   - Ensures feature always works

### Metadata Tracking
Events and tasks are tracked using Google Calendar's extended properties:
- `isAnalyzed`: Marks events that have been analyzed
- `analyzedAt`: Timestamp of analysis
- `tasksCount`: Number of linked preparation tasks
- `isAIGenerated`: Identifies AI-generated tasks
- `originalEventId`: Links tasks back to source event

## Future Enhancements

- [ ] Persistent database (replace in-memory stores)
- [ ] User accounts and multi-user support
- [ ] Real Uber API integration
- [ ] Calendar sharing and collaboration
- [ ] Mobile app (React Native)
- [ ] Push notifications for task reminders
- [ ] Recurring event handling improvements
- [ ] Custom AI prompts for different event types
- [ ] Multiple calendar support
- [ ] Meal plan export to grocery apps

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT License