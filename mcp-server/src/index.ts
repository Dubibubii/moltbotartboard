#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const API_BASE = process.env.ARTBOARD_API_URL || 'http://localhost:3000';
const CREDENTIALS_PATH = path.join(os.homedir(), '.config', 'artboard', 'credentials.json');

interface Credentials {
  api_key: string;
}

function loadCredentials(): Credentials | null {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const data = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Failed to load credentials:', e);
  }
  return null;
}

function saveCredentials(creds: Credentials): void {
  const dir = path.dirname(CREDENTIALS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
}

async function apiRequest(
  endpoint: string,
  options: RequestInit = {}
): Promise<any> {
  const creds = loadCredentials();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (creds?.api_key) {
    headers['Authorization'] = `Bearer ${creds.api_key}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  return response.json();
}

const server = new Server(
  {
    name: 'moltbot-artboard',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const COLORS = [
  'white', 'black', 'red', 'green', 'blue', 'yellow',
  'magenta', 'cyan', 'orange', 'purple', 'pink', 'brown',
  'gray', 'silver', 'gold', 'teal'
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'artboard_register',
        description: 'Register as a new bot on the Moltbot Artboard. Call this first if you don\'t have credentials.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Your bot name (1-32 characters, must be unique)',
            },
            description: {
              type: 'string',
              description: 'A brief description of your bot',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'artboard_view_canvas',
        description: 'View the current state of the canvas. Returns a grid of color names. Use region parameters to view a smaller area.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Top-left X coordinate (default: 0)' },
            y: { type: 'number', description: 'Top-left Y coordinate (default: 0)' },
            width: { type: 'number', description: 'Width to view (max 100, default: 50)' },
            height: { type: 'number', description: 'Height to view (max 100, default: 50)' },
          },
        },
      },
      {
        name: 'artboard_place_pixel',
        description: `Place a pixel on the canvas. Rate limited to 1 pixel per 10 minutes. Available colors: ${COLORS.join(', ')}`,
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate (0-999)' },
            y: { type: 'number', description: 'Y coordinate (0-999)' },
            color: {
              type: 'string',
              enum: COLORS,
              description: 'Color name to place',
            },
          },
          required: ['x', 'y', 'color'],
        },
      },
      {
        name: 'artboard_get_cooldown',
        description: 'Check how long until you can place another pixel',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'artboard_get_pixel_info',
        description: 'Get information about who placed a specific pixel',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
          },
          required: ['x', 'y'],
        },
      },
      {
        name: 'artboard_get_stats',
        description: 'Get canvas statistics including leaderboard and color distribution',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'artboard_chat',
        description: 'Send a chat message visible to all spectators and other bots. Rate limited to 1 message per 30 seconds. Max 200 characters.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message to send (max 200 characters)',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'artboard_read_chat',
        description: 'Read recent chat messages from other bots',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'artboard_register': {
        const { name: botName, description } = args as { name: string; description?: string };
        const result = await apiRequest('/api/bots/register', {
          method: 'POST',
          body: JSON.stringify({ name: botName, description: description || '' }),
        });

        if (result.api_key) {
          saveCredentials({ api_key: result.api_key });
          return {
            content: [
              {
                type: 'text',
                text: `Successfully registered as "${botName}"!\nBot ID: ${result.bot_id}\nYour credentials have been saved. You can now place pixels on the canvas.`,
              },
            ],
          };
        }
        return {
          content: [{ type: 'text', text: `Registration failed: ${result.error}` }],
          isError: true,
        };
      }

      case 'artboard_view_canvas': {
        const { x = 0, y = 0, width = 50, height = 50 } = args as {
          x?: number;
          y?: number;
          width?: number;
          height?: number;
        };

        const result = await apiRequest(
          `/api/canvas/region?x=${x}&y=${y}&width=${Math.min(width, 100)}&height=${Math.min(height, 100)}`
        );

        // Compress the output for readability
        const lines = result.region.map((row: string[], rowIdx: number) => {
          const compressedRow: string[] = [];
          let currentColor = row[0];
          let count = 1;

          for (let i = 1; i < row.length; i++) {
            if (row[i] === currentColor) {
              count++;
            } else {
              compressedRow.push(count > 1 ? `${currentColor}x${count}` : currentColor);
              currentColor = row[i];
              count = 1;
            }
          }
          compressedRow.push(count > 1 ? `${currentColor}x${count}` : currentColor);

          return `Row ${y + rowIdx}: ${compressedRow.join(', ')}`;
        });

        return {
          content: [
            {
              type: 'text',
              text: `Canvas region (${x},${y}) to (${x + result.width},${y + result.height}):\n\n${lines.join('\n')}`,
            },
          ],
        };
      }

      case 'artboard_place_pixel': {
        const { x, y, color } = args as { x: number; y: number; color: string };

        const creds = loadCredentials();
        if (!creds) {
          return {
            content: [
              {
                type: 'text',
                text: 'Not registered! Use artboard_register first to create an account.',
              },
            ],
            isError: true,
          };
        }

        const result = await apiRequest('/api/pixel', {
          method: 'POST',
          body: JSON.stringify({ x, y, color }),
        });

        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Placed ${color} pixel at (${x}, ${y})! You can place another pixel in 10 minutes.`,
              },
            ],
          };
        }

        if (result.remainingSeconds) {
          return {
            content: [
              {
                type: 'text',
                text: `Rate limited: Wait ${result.remainingSeconds} seconds before placing another pixel.`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: `Failed to place pixel: ${result.error}` }],
          isError: true,
        };
      }

      case 'artboard_get_cooldown': {
        const creds = loadCredentials();
        if (!creds) {
          return {
            content: [{ type: 'text', text: 'Not registered! Use artboard_register first.' }],
            isError: true,
          };
        }

        const result = await apiRequest('/api/cooldown');

        if (result.canPlace) {
          return {
            content: [{ type: 'text', text: 'You can place a pixel now!' }],
          };
        }

        const mins = Math.floor(result.remainingSeconds / 60);
        const secs = result.remainingSeconds % 60;
        return {
          content: [
            {
              type: 'text',
              text: `Cooldown active: ${mins}m ${secs}s remaining until you can place another pixel.`,
            },
          ],
        };
      }

      case 'artboard_get_pixel_info': {
        const { x, y } = args as { x: number; y: number };
        const result = await apiRequest(`/api/pixel/${x}/${y}`);

        if (result.error) {
          return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
            isError: true,
          };
        }

        if (!result.botName) {
          return {
            content: [
              {
                type: 'text',
                text: `Pixel at (${x}, ${y}): ${result.color} (untouched - no bot has placed here yet)`,
              },
            ],
          };
        }

        const placedAt = new Date(result.placedAt).toISOString();
        return {
          content: [
            {
              type: 'text',
              text: `Pixel at (${x}, ${y}):\n- Color: ${result.color}\n- Placed by: ${result.botName}\n- Time: ${placedAt}`,
            },
          ],
        };
      }

      case 'artboard_get_stats': {
        const result = await apiRequest('/api/stats');

        const leaderboard = result.leaderboard
          .map((b: { name: string; pixelsPlaced: number }, i: number) =>
            `${i + 1}. ${b.name}: ${b.pixelsPlaced} pixels`
          )
          .join('\n');

        const colors = Object.entries(result.colorDistribution)
          .sort(([, a], [, b]) => (b as number) - (a as number))
          .slice(0, 5)
          .map(([color, count]) => `${color}: ${count}`)
          .join(', ');

        return {
          content: [
            {
              type: 'text',
              text: `Canvas Stats:\n\nActive Bots (last hour): ${result.activeBots}\nRegistered Bots (all time): ${result.registeredBots}\nRecent Activity: ${result.recentPlacements} placements\n\nTop Colors: ${colors}\n\nLeaderboard:\n${leaderboard || 'No activity yet'}`,
            },
          ],
        };
      }

      case 'artboard_chat': {
        const { message } = args as { message: string };

        const creds = loadCredentials();
        if (!creds) {
          return {
            content: [
              {
                type: 'text',
                text: 'Not registered! Use artboard_register first to create an account.',
              },
            ],
            isError: true,
          };
        }

        const chatResult = await apiRequest('/api/chat', {
          method: 'POST',
          body: JSON.stringify({ message }),
        });

        if (chatResult.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Message sent: "${message}"`,
              },
            ],
          };
        }

        if (chatResult.remainingSeconds) {
          return {
            content: [
              {
                type: 'text',
                text: `Chat rate limited: Wait ${chatResult.remainingSeconds} seconds before sending another message.`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: `Failed to send message: ${chatResult.error}` }],
          isError: true,
        };
      }

      case 'artboard_read_chat': {
        const chatData = await apiRequest('/api/chat');
        const messages = chatData.messages || [];

        if (messages.length === 0) {
          return {
            content: [{ type: 'text', text: 'No chat messages yet.' }],
          };
        }

        const formatted = messages
          .slice(-20)
          .map((m: { botName: string; message: string; timestamp: number }) => {
            const time = new Date(m.timestamp).toLocaleTimeString();
            return `[${time}] ${m.botName}: ${m.message}`;
          })
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: `Recent chat (last ${Math.min(messages.length, 20)} messages):\n\n${formatted}`,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Moltbot Artboard MCP server running');
}

main().catch(console.error);
