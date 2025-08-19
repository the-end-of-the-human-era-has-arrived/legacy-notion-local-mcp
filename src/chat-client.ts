// src/chat-client.ts
import OpenAI from 'openai';
import readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import { ChatMessage } from './types.js';
import dotenv from 'dotenv';

dotenv.config();

interface MCPResponse {
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

class TerminalChatClient {
  private openai: OpenAI;
  private mcpProcess: ChildProcess | null = null;
  private rl: readline.Interface;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  private async initializeMCP() {
    console.log('🔄 MCP 서버 시작 중...');
    
    this.mcpProcess = spawn('node', ['dist/mcp-server.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd()
    });

    this.mcpProcess.on('error', (error) => {
      console.error('❌ MCP 프로세스 오류:', error);
      process.exit(1);
    });

    this.mcpProcess.on('exit', (code) => {
      if (code !== 0) {
        console.error(`❌ MCP 프로세스가 종료되었습니다 (코드: ${code})`);
        process.exit(1);
      }
    });

    this.mcpProcess.stdout?.on('data', (data) => {
      this.handleMCPResponse(data);
    });

    this.mcpProcess.stderr?.on('data', (data) => {
      const message = data.toString();
      if (message.includes('Notion MCP Server started')) {
        console.log('✅ MCP 서버 시작 완료');
      } else {
        console.error('MCP 서버 로그:', message);
      }
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
      await this.sendMCPRequest({
        jsonrpc: "2.0",
        id: this.getNextId(),
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {}
          },
          clientInfo: {
            name: "notion-chat-client",
            version: "1.0.0"
          }
        }
      });
      console.log('✅ MCP 초기화 완료\n');
    } catch (error) {
      console.error('❌ MCP 초기화 실패:', error);
      process.exit(1);
    }
  }

  private handleMCPResponse(data: Buffer) {
    const lines = data.toString().split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      try {
        const response: MCPResponse = JSON.parse(line);
        const pending = this.pendingRequests.get(response.id);
        
        if (pending) {
          this.pendingRequests.delete(response.id);
          
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch (parseError) {
        // JSON 파싱 실패는 무시
      }
    }
  }

  private getNextId(): number {
    return ++this.requestId;
  }

  private async sendMCPRequest(request: any): Promise<any> {
    if (!this.mcpProcess) {
      throw new Error('MCP 프로세스가 실행되지 않았습니다');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error('MCP 응답 타임아웃'));
      }, 20000);

      this.pendingRequests.set(request.id, {
        resolve: (result: any) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.mcpProcess!.stdin?.write(JSON.stringify(request) + '\n');
    });
  }

  private async callMCPTool(toolName: string, params: any): Promise<any> {
    const request = {
      jsonrpc: "2.0",
      id: this.getNextId(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: params
      }
    };

    const result = await this.sendMCPRequest(request);
    
    if (result.content && result.content[0] && result.content[0].text) {
      try {
        return JSON.parse(result.content[0].text);
      } catch {
        return result.content[0].text;
      }
    }
    
    return result;
  }

  private async processUserMessage(message: string): Promise<string> {
    console.log('🤖 AI가 적절한 노션 기능을 선택하고 있습니다...');
  
    try {
      // OpenAI Function Calling을 사용하여 적절한 도구 선택
      const response = await this.openai.chat.completions.create({
        model: "o3-mini",
        messages: [
          {
            role: "system",
            content: `당신은 Notion 워크스페이스 관리 AI입니다. 사용자의 요청을 분석하여 적절한 Notion 도구를 선택하고 실행하세요.
  
  사용 가능한 도구들:
  - search_notion: 키워드로 문서 검색
  - list_recent_pages: 최근 작성/수정된 페이지 목록
  - get_page_titles_only: 페이지 제목만 가져오기 (목록 표시용)
  - list_all_pages: 모든 페이지 목록
  - get_page_content: 특정 페이지의 전체 내용
  
  사용자 요청 분석 가이드:
  - "글 3개만 제목만" → get_page_titles_only (limit: 3)
  - "최근 글" → list_recent_pages
  - "모든 글" → list_all_pages
  - "~에 대한 글" → search_notion
  - "~본문" "~요약" "~내용" → search_notion (먼저 찾고, 이후 get_page_content로 전체 내용)`
          },
          {
            role: "user",
            content: message
          }
        ],
        tools: [
          // ... (기존 tools 배열 그대로 유지)
          {
            type: "function",
            function: {
              name: "search_notion",
              description: "Search through Notion workspace using keywords",
              parameters: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "Search query or keywords"
                  },
                  limit: {
                    type: "number",
                    description: "Number of results to return",
                    default: 10
                  }
                },
                required: ["query"]
              }
            }
          },
          {
            type: "function",
            function: {
              name: "list_recent_pages",
              description: "List recently created or updated pages",
              parameters: {
                type: "object",
                properties: {
                  limit: {
                    type: "number",
                    description: "Number of pages to return",
                    default: 10
                  },
                  sort: {
                    type: "string",
                    enum: ["created_time", "last_edited_time"],
                    description: "Sort by created time or last edited time",
                    default: "last_edited_time"
                  }
                }
              }
            }
          },
          {
            type: "function",
            function: {
              name: "get_page_titles_only",
              description: "Get only titles of pages (useful for listing)",
              parameters: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "Optional search query to filter pages"
                  },
                  limit: {
                    type: "number",
                    description: "Number of titles to return",
                    default: 10
                  }
                }
              }
            }
          },
          {
            type: "function",
            function: {
              name: "list_all_pages",
              description: "List all pages in the workspace",
              parameters: {
                type: "object",
                properties: {
                  limit: {
                    type: "number",
                    description: "Number of pages to return",
                    default: 20
                  }
                }
              }
            }
          },
          {
            type: "function",
            function: {
              name: "get_page_content",
              description: "Get full content of a specific Notion page",
              parameters: {
                type: "object",
                properties: {
                  pageId: {
                    type: "string",
                    description: "Notion page ID"
                  }
                },
                required: ["pageId"]
              }
            }
          }
        ],
        tool_choice: "auto"
        // temperature 파라미터 제거
      });

      const message_response = response.choices[0].message;
      
      if (message_response.tool_calls && message_response.tool_calls.length > 0) {
        console.log(`🔧 선택된 도구: ${message_response.tool_calls[0].function.name}`);
        
        let notionResults: any[] = [];
        
        // 모든 도구 호출 실행
        for (const toolCall of message_response.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments);
          
          console.log(`🔍 ${toolName} 실행 중...`, toolArgs);
          
          try {
            const result = await this.callMCPTool(toolName, toolArgs);
            if (Array.isArray(result)) {
              notionResults.push(...result);
            } else if (result && !result.error) {
              notionResults.push(result);
            }
          } catch (error) {
            console.error(`도구 ${toolName} 실행 실패:`, error);
          }
        }

        console.log(`✅ ${notionResults.length}개의 결과를 찾았습니다.`);

        if (notionResults.length === 0) {
          return '요청하신 내용을 찾을 수 없습니다.';
        }

        // 최종 응답 생성
        const finalResponse = await this.generateFinalResponse(message, notionResults, message_response.tool_calls[0].function.name);
        return finalResponse;

      } else {
        // 도구 호출이 없는 경우 일반 응답
        return message_response.content || '죄송합니다. 요청을 처리할 수 없습니다.';
      }

    } catch (error) {
      console.error('처리 중 오류:', error);
      return `처리 중 오류가 발생했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`;
    }
  }

  private async generateFinalResponse(userMessage: string, notionData: any[], toolUsed: string): Promise<string> {
    // 도구에 따라 다른 포맷으로 응답 생성
    if (toolUsed === 'get_page_titles_only' || userMessage.includes('제목만')) {
      // 제목만 요청한 경우
      return `📋 **페이지 제목 목록:**\n\n${notionData.map((item, index) => `${index + 1}. ${item.title}`).join('\n')}`;
    }
  
    if (toolUsed === 'list_recent_pages' || toolUsed === 'list_all_pages') {
      // 페이지 목록 요청한 경우
      return `📋 **페이지 목록:**\n\n${notionData.map((item, index) => {
        const date = new Date(item.last_edited_time).toLocaleDateString('ko-KR');
        return `${index + 1}. **${item.title}** (${date})`;
      }).join('\n')}`;
    }
  
    // 특정 글의 본문 요약이나 내용을 요청한 경우
    if (userMessage.includes('본문') || userMessage.includes('요약') || userMessage.includes('내용')) {
      // 첫 번째 결과의 전체 내용을 가져오기
      if (notionData.length > 0 && notionData[0].id) {
        try {
          console.log(`📖 "${notionData[0].title}" 페이지의 전체 내용을 가져오는 중...`);
          const fullContent = await this.callMCPTool('get_page_content', {
            pageId: notionData[0].id
          });
  
          // o3 모델로 요약 생성 (temperature 제거)
          const response = await this.openai.chat.completions.create({
            model: "o3-mini",
            messages: [
              {
                role: "system",
                content: `다음은 "${notionData[0].title}"라는 노션 페이지의 전체 내용입니다. 사용자의 요청에 따라 이 내용을 요약하거나 설명해주세요.
  
  페이지 내용:
  ${fullContent}`
              },
              {
                role: "user",
                content: userMessage
              }
            ]
            // temperature 파라미터 제거
          });
  
          return `📄 **${notionData[0].title}** 요약:\n\n${response.choices[0].message.content}`;
  
        } catch (error) {
          console.error('페이지 내용 가져오기 실패:', error);
          return `"${notionData[0].title}" 페이지의 내용을 가져올 수 없습니다.`;
        }
      }
    }
  
    // 일반적인 검색 결과인 경우
    const context = notionData.slice(0, 3).map(doc => {
      if (doc.content) {
        return `제목: ${doc.title}\n내용: ${doc.content.slice(0, 300)}...\n`;
      } else {
        return `제목: ${doc.title}\n`;
      }
    }).join('\n---\n');
  
    const response = await this.openai.chat.completions.create({
      model: "o3-mini",
      messages: [
        {
          role: "system",
          content: `사용자의 노션 워크스페이스에서 찾은 정보를 바탕으로 유용한 답변을 제공하세요.
          
          찾은 정보:
          ${context}`
        },
        {
          role: "user",
          content: userMessage
        }
      ]
      // temperature 파라미터 제거
    });
  
    return response.choices[0].message.content || '응답을 생성할 수 없습니다.';
  }

  async startChat() {
    try {
      await this.initializeMCP();
    } catch (error) {
      console.error('❌ MCP 초기화 실패:', error);
      process.exit(1);
    }

    console.log('🤖 노션 AI 채팅봇에 오신 것을 환영합니다! (o3-mini 모델 사용)');
    console.log('💡 노션 워크스페이스 내용에 대해 자유롭게 질문해보세요.');
    console.log('📝 예시: "내가 작성한 글 3개만 제목만 보여줘", "최근 글 목록", "백엔드 관련 글 찾아줘"');
    console.log('❌ "exit" 또는 "quit"를 입력하면 종료됩니다.\n');

    const askQuestion = () => {
      this.rl.question('🔍 질문: ', async (input) => {
        const message = input.trim();

        if (message.toLowerCase() === 'exit' || message.toLowerCase() === 'quit') {
          console.log('\n👋 채팅을 종료합니다.');
          this.cleanup();
          return;
        }

        if (!message) {
          askQuestion();
          return;
        }

        console.log('\n⏳ 처리 중...\n');

        try {
          const response = await this.processUserMessage(message);
          console.log('\n🤖 답변:');
          console.log('─'.repeat(50));
          console.log(response);
          console.log('─'.repeat(50));
          console.log();
        } catch (error) {
          console.error('❌ 오류:', error);
        }

        askQuestion();
      });
    };

    askQuestion();
  }

  private cleanup() {
    if (this.mcpProcess) {
      this.mcpProcess.kill();
    }
    this.rl.close();
    process.exit(0);
  }
}

const client = new TerminalChatClient();
client.startChat().catch(console.error);