// --- Imports ---
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const tmi = require('tmi.js');
const { google } = require('googleapis');

// --- Basic Server Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow connections from anywhere. For production, you might want to restrict this.
        methods: ["GET", "POST"]
    }
});
const PORT = process.env.PORT || 3001;

// --- API Configuration ---
// IMPORTANT: These are loaded from your Render Environment Variables
const TWITCH_USERNAME = process.env.TWITCH_USERNAME;
const TWITCH_OAUTH_TOKEN = process.env.TWITCH_OAUTH_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const youtube = google.youtube({
    version: 'v3',
    auth: YOUTUBE_API_KEY
});

// --- State Management ---
let twitchChannel = null;
let youtubeLiveChatId = null;
let youtubeInterval = null;
let lastYoutubeCheck = null;

// --- Twitch Client Setup ---
const twitchClient = new tmi.Client({
    options: { debug: false },
    identity: {
        username: TWITCH_USERNAME,
        password: TWITCH_OAUTH_TOKEN
    }
});

twitchClient.on('message', (channel, tags, message, self) => {
    if (self) return;

    const chatMessage = {
        id: tags.id,
        platform: 'Twitch',
        user: tags['display-name'],
        text: message,
        isSubscriber: tags.subscriber || tags.mod, // mods are often treated like subs
        color: tags.color
    };
    io.emit('chat message', chatMessage);
});

// --- YouTube Functions ---
async function getLiveChatId(youtubeChannelId) {
    try {
        const response = await youtube.search.list({
            part: 'snippet',
            channelId: youtubeChannelId,
            eventType: 'live',
            type: 'video'
        });

        if (response.data.items.length > 0) {
            const liveVideoId = response.data.items[0].id.videoId;
            const videoResponse = await youtube.videos.list({
                part: 'liveStreamingDetails',
                id: liveVideoId
            });
            return videoResponse.data.items[0].liveStreamingDetails.activeLiveChatId;
        }
        return null;
    } catch (error) {
        console.error('Error getting YouTube Live Chat ID:', error.message);
        io.emit('error message', 'Could not find an active YouTube live stream for that channel.');
        return null;
    }
}

async function fetchYoutubeMessages() {
    if (!youtubeLiveChatId) return;

    try {
        const response = await youtube.liveChatMessages.list({
            liveChatId: youtubeLiveChatId,
            part: 'snippet,authorDetails',
            maxResults: 200, // Fetch a larger batch
        });
        
        const newMessages = response.data.items;
        if (newMessages.length > 0) {
            newMessages.forEach(item => {
                // This logic is a simplified way to avoid sending old messages on every poll
                const publishedAt = new Date(item.snippet.publishedAt);
                if (!lastYoutubeCheck || publishedAt > lastYoutubeCheck) {
                     const chatMessage = {
                        id: item.id,
                        platform: 'YouTube',
                        user: item.authorDetails.displayName,
                        text: item.snippet.displayMessage,
                        isSubscriber: item.authorDetails.isChatSponsor,
                     };
                     io.emit('chat message', chatMessage);
                }
            });
            // Update the timestamp of the last message we've seen
            lastYoutubeCheck = new Date(newMessages[newMessages.length - 1].snippet.publishedAt);
        }

    } catch (error) {
        console.error('Error fetching YouTube messages:', error.message);
        // If chat has ended, stop polling
        if (error.response && error.response.data.error.message.includes('The live chat is no longer available')) {
             console.log('YouTube Live Chat has ended. Stopping polling.');
             clearInterval(youtubeInterval);
             youtubeLiveChatId = null;
             io.emit('error message', 'YouTube Live Chat has ended.');
        }
    }
}


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected to the server.');

    socket.on('start connection', async (data) => {
        console.log('Received connection request:', data);

        // Connect to Twitch
        if (data.twitchChannel) {
            twitchChannel = data.twitchChannel;
            await twitchClient.connect().catch(console.error);
            twitchClient.join(twitchChannel).catch(console.error);
            console.log(`Connected to Twitch channel: ${twitchChannel}`);
        }

        // Connect to YouTube
        if (data.youtubeChannelId) {
             lastYoutubeCheck = new Date(); // Set initial time to avoid fetching entire backlog
             youtubeLiveChatId = await getLiveChatId(data.youtubeChannelId);
             if (youtubeLiveChatId) {
                console.log(`Found YouTube Live Chat ID: ${youtubeLiveChatId}`);
                // Poll every 10 seconds. Be mindful of API quotas.
                youtubeInterval = setInterval(fetchYoutubeMessages, 10000); 
             }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected.');
        // Clean up when no users are connected (optional, but good practice)
        if (io.engine.clientsCount === 0) {
            if (twitchChannel) {
                twitchClient.part(twitchChannel).catch(console.error);
                twitchChannel = null;
                console.log('Disconnected from Twitch channel.');
            }
            if (youtubeInterval) {
                clearInterval(youtubeInterval);
                youtubeInterval = null;
                youtubeLiveChatId = null;
                console.log('Stopped polling YouTube.');
            }
        }
    });
});
