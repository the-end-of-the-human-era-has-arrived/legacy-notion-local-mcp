// src/mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@notionhq/client';
import dotenv from 'dotenv';
dotenv.config();
class NotionMCPServer {
    notion;
    server;
    constructor() {
        this.notion = new Client({
            auth: process.env.NOTION_TOKEN,
        });
        this.server = new Server({
            name: "notion-server",
            version: "1.0.0",
            capabilities: {
                tools: {},
            },
        });
        this.setupHandlers();
    }
    setupHandlers() {
        // 도구 목록 반환
        this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
            return {
                tools: [
                    {
                        name: "search_notion",
                        description: "Search through Notion workspace using keywords",
                        inputSchema: {
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
                    },
                    {
                        name: "list_recent_pages",
                        description: "List recently created or updated pages",
                        inputSchema: {
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
                    },
                    {
                        name: "get_page_titles_only",
                        description: "Get only titles of pages (useful for listing)",
                        inputSchema: {
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
                    },
                    {
                        name: "get_page_content",
                        description: "Get full content of a specific Notion page",
                        inputSchema: {
                            type: "object",
                            properties: {
                                pageId: {
                                    type: "string",
                                    description: "Notion page ID"
                                }
                            },
                            required: ["pageId"]
                        }
                    },
                    {
                        name: "list_all_pages",
                        description: "List all pages in the workspace",
                        inputSchema: {
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
                ]
            };
        });
        // 도구 실행 핸들러
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            try {
                switch (name) {
                    case "search_notion": {
                        const query = args.query;
                        const limit = args.limit || 10;
                        const results = await this.searchNotion(query, limit);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(results)
                                }
                            ]
                        };
                    }
                    case "list_recent_pages": {
                        const limit = args.limit || 10;
                        const sort = args.sort || "last_edited_time";
                        const results = await this.listRecentPages(limit, sort);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(results)
                                }
                            ]
                        };
                    }
                    case "get_page_titles_only": {
                        const query = args.query;
                        const limit = args.limit || 10;
                        const results = await this.getPageTitlesOnly(query, limit);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(results)
                                }
                            ]
                        };
                    }
                    case "list_all_pages": {
                        const limit = args.limit || 20;
                        const results = await this.listAllPages(limit);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(results)
                                }
                            ]
                        };
                    }
                    case "get_page_content": {
                        const pageId = args.pageId;
                        const content = await this.getPageContent(pageId);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: content
                                }
                            ]
                        };
                    }
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.error(`Tool ${name} error:`, errorMessage);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: errorMessage })
                        }
                    ],
                    isError: true
                };
            }
        });
    }
    async searchNotion(query, limit) {
        try {
            console.error(`🔍 Searching for: "${query}" (limit: ${limit})`);
            const response = await this.notion.search({
                query,
                page_size: Math.min(limit, 100),
                filter: {
                    value: "page",
                    property: "object"
                }
            });
            console.error(`📄 Found ${response.results.length} results`);
            const results = [];
            for (const item of response.results) {
                if (item.object === 'page' && 'properties' in item) {
                    const title = this.extractTitle(item);
                    const content = await this.getPagePreview(item.id);
                    results.push({
                        id: item.id,
                        title,
                        content,
                        url: item.url || '',
                        type: 'page'
                    });
                }
            }
            console.error(`✅ Processed ${results.length} results`);
            return results;
        }
        catch (error) {
            console.error('Search error:', error);
            return [];
        }
    }
    async listRecentPages(limit, sortBy) {
        try {
            console.error(`📋 Listing recent pages (limit: ${limit}, sort: ${sortBy})`);
            const response = await this.notion.search({
                filter: {
                    value: "page",
                    property: "object"
                },
                sort: {
                    direction: "descending",
                    timestamp: "last_edited_time" // 항상 last_edited_time 사용
                },
                page_size: Math.min(limit, 100)
            });
            const results = [];
            for (const item of response.results) {
                if (item.object === 'page' && 'properties' in item) {
                    results.push({
                        id: item.id,
                        title: this.extractTitle(item),
                        created_time: item.created_time,
                        last_edited_time: item.last_edited_time,
                        url: item.url || ''
                    });
                }
            }
            // sortBy 파라미터에 따라 클라이언트 사이드에서 정렬
            if (sortBy === "created_time") {
                results.sort((a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime());
            }
            // last_edited_time은 이미 API에서 정렬됨
            console.error(`✅ Found ${results.length} recent pages`);
            return results;
        }
        catch (error) {
            console.error('List recent pages error:', error);
            return [];
        }
    }
    async getPageTitlesOnly(query, limit = 10) {
        try {
            console.error(`📋 Getting page titles only (query: ${query || 'all'}, limit: ${limit})`);
            const searchParams = {
                filter: {
                    value: "page",
                    property: "object"
                },
                page_size: Math.min(limit, 100)
            };
            if (query) {
                searchParams.query = query;
            }
            const response = await this.notion.search(searchParams);
            const results = response.results
                .filter(item => item.object === 'page' && 'properties' in item)
                .map(item => ({
                id: item.id,
                title: this.extractTitle(item),
                url: item.url || ''
            }));
            console.error(`✅ Found ${results.length} page titles`);
            return results;
        }
        catch (error) {
            console.error('Get page titles error:', error);
            return [];
        }
    }
    async listAllPages(limit) {
        try {
            console.error(`📋 Listing all pages (limit: ${limit})`);
            const response = await this.notion.search({
                filter: {
                    value: "page",
                    property: "object"
                },
                page_size: Math.min(limit, 100),
                sort: {
                    direction: "descending",
                    timestamp: "last_edited_time"
                }
            });
            const results = [];
            for (const item of response.results) {
                if (item.object === 'page' && 'properties' in item) {
                    results.push({
                        id: item.id,
                        title: this.extractTitle(item),
                        created_time: item.created_time,
                        last_edited_time: item.last_edited_time,
                        url: item.url || ''
                    });
                }
            }
            console.error(`✅ Found ${results.length} total pages`);
            return results;
        }
        catch (error) {
            console.error('List all pages error:', error);
            return [];
        }
    }
    async getPageContent(pageId) {
        try {
            console.error(`📖 Getting content for page: ${pageId}`);
            const blocks = await this.notion.blocks.children.list({
                block_id: pageId,
                page_size: 100
            });
            let content = '';
            for (const block of blocks.results) {
                const blockText = this.extractBlockText(block);
                if (blockText.trim()) {
                    content += blockText + '\n';
                }
            }
            return content.trim() || 'No content found';
        }
        catch (error) {
            console.error('Get page content error:', error);
            return 'Error retrieving content';
        }
    }
    async getPagePreview(pageId) {
        try {
            const blocks = await this.notion.blocks.children.list({
                block_id: pageId,
                page_size: 3
            });
            let preview = '';
            for (const block of blocks.results) {
                const blockText = this.extractBlockText(block);
                if (blockText.trim()) {
                    preview += blockText + ' ';
                    if (preview.length > 200)
                        break;
                }
            }
            return preview.trim() || 'No preview available';
        }
        catch (error) {
            return 'Preview unavailable';
        }
    }
    extractTitle(page) {
        try {
            if (!page.properties)
                return 'Untitled';
            for (const [key, value] of Object.entries(page.properties)) {
                if (value && typeof value === 'object' && 'type' in value && value.type === 'title') {
                    const titleData = value;
                    if (titleData.title && Array.isArray(titleData.title) && titleData.title.length > 0) {
                        return titleData.title[0].plain_text || 'Untitled';
                    }
                }
            }
            return 'Untitled';
        }
        catch (error) {
            return 'Untitled';
        }
    }
    extractBlockText(block) {
        try {
            if (!block || !block.type)
                return '';
            const blockType = block.type;
            const blockData = block[blockType];
            if (!blockData)
                return '';
            if (blockData.rich_text && Array.isArray(blockData.rich_text)) {
                return blockData.rich_text
                    .map((text) => text.plain_text || '')
                    .join('');
            }
            if (blockData.text && Array.isArray(blockData.text)) {
                return blockData.text
                    .map((text) => text.plain_text || '')
                    .join('');
            }
            return '';
        }
        catch (error) {
            return '';
        }
    }
    async start() {
        try {
            const transport = new StdioServerTransport();
            await this.server.connect(transport);
            console.error('🚀 Notion MCP Server started and connected');
        }
        catch (error) {
            console.error('Server start error:', error);
            process.exit(1);
        }
    }
}
if (import.meta.url === `file://${process.argv[1]}`) {
    const server = new NotionMCPServer();
    server.start().catch((error) => {
        console.error('Failed to start server:', error);
        process.exit(1);
    });
}
