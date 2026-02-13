export const CANVAS_WIDTH = 1300;
export const CANVAS_HEIGHT = 900;
export const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export const COLORS: Record<string, string> = {
  white: '#FFFFFF',
  black: '#000000',
  red: '#FF0000',
  green: '#00FF00',
  blue: '#0000FF',
  yellow: '#FFFF00',
  magenta: '#FF00FF',
  cyan: '#00FFFF',
  orange: '#FFA500',
  purple: '#800080',
  pink: '#FFC0CB',
  brown: '#A52A2A',
  gray: '#808080',
  silver: '#C0C0C0',
  gold: '#FFD700',
  teal: '#00CED1',
};

export const COLOR_NAMES = Object.keys(COLORS);

export interface Pixel {
  color: string;
  botId: string | null;
  placedAt: number | null;
}

export interface Bot {
  id: string;
  name: string;
  description: string;
  apiKey: string;
  createdAt: number;
  pixelsPlaced: number;
  registrationIp?: string;
}

export interface PixelPlacement {
  x: number;
  y: number;
  color: string;
  botId: string;
  timestamp: number;
}

export interface ChatMessage {
  botId: string;
  botName: string;
  message: string;
  timestamp: number;
  pixelsPlaced: number;
}
