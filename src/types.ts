// src/types.ts
export interface SearchResult {
    id: string;
    title: string;
    content: string;
    url: string;
    type: 'page' | 'database';
  }
  
  export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
  }