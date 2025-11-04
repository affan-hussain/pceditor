import OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';

type AssistantRole = 'system' | 'developer' | 'user' | 'assistant';

type AssistantMessage = {
    role: AssistantRole;
    content: string;
    type?: 'message';
};

export type AssistantClientOptions = {
    apiKey?: string | (() => Promise<string> | string);
    baseUrl?: string;
    model?: string;
    instructions?: string;
    organization?: string;
    project?: string;
    headers?: Record<string, string | undefined>;
};

export type AssistantSendOptions = {
    signal?: AbortSignal;
};

export type AssistantResult = {
    text: string;
    response: Response;
};

const DEFAULT_MODEL = 'gpt-4.1-mini';
const RESPONSES_BETA_HEADER = 'responses=v1';

const envString = (raw?: string | null): string | undefined => {
    if (!raw) {
        return undefined;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const ENV_FALLBACKS: AssistantClientOptions = {
    apiKey: envString(process.env.OPENAI_API_KEY),
    baseUrl: envString(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || process.env.OPENAI_ENDPOINT),
    model: envString(process.env.OPENAI_MODEL),
    instructions: envString(process.env.OPENAI_ASSISTANT_INSTRUCTIONS),
    organization: envString(process.env.OPENAI_ORG || process.env.OPENAI_ORGANIZATION),
    project: envString(process.env.OPENAI_PROJECT),
    headers: undefined
};

export class AssistantClient {
    private openai: OpenAI | null;
    private readonly options: AssistantClientOptions & { model: string; headers: Record<string, string | undefined> };
    private conversation: AssistantMessage[] = [];

    constructor(options: AssistantClientOptions = {}) {
        const resolvedOptions: AssistantClientOptions = {
            ...ENV_FALLBACKS,
            ...options
        };

        const mergedHeaders = {
            'OpenAI-Beta': RESPONSES_BETA_HEADER,
            ...(resolvedOptions.headers || {})
        };

        this.options = {
            ...resolvedOptions,
            model: resolvedOptions.model || DEFAULT_MODEL,
            headers: mergedHeaders
        };

        if (this.options.instructions) {
            this.conversation.push({
                role: 'system',
                content: this.options.instructions,
                type: 'message'
            });
        }

        this.openai = this.createClient();
    }

    private createClient(): OpenAI | null {
        if (!this.options.apiKey) {
            return null;
        }

        try {
            // Remove undefined headers so the OpenAI SDK does not send them.
            const headers = Object.fromEntries(
                Object.entries(this.options.headers || {}).filter(([, value]) => value !== undefined && value !== null)
            );

            return new OpenAI({
                apiKey: this.options.apiKey,
                baseURL: this.options.baseUrl,
                organization: this.options.organization ?? null,
                project: this.options.project ?? null,
                defaultHeaders: headers,
                dangerouslyAllowBrowser: true
            });
        } catch (err) {
            console.warn('Failed to initialize OpenAI client for assistant', err);
            return null;
        }
    }

    isReady(): boolean {
        return !!this.openai;
    }

    resetConversation() {
        this.conversation = [];
        if (this.options.instructions) {
            this.conversation.push({
                role: 'system',
                content: this.options.instructions,
                type: 'message'
            });
        }
    }

    async send(text: string, options?: AssistantSendOptions): Promise<AssistantResult> {
        if (!this.openai) {
            throw new Error('Assistant backend is not configured.');
        }

        const userMessage: AssistantMessage = {
            role: 'user',
            content: text,
            type: 'message'
        };
        this.conversation.push(userMessage);

        try {
            const response = await this.openai.responses.create({
                model: this.options.model,
                input: this.conversation
            }, {
                signal: options?.signal
            });

            const assistantText = AssistantClient.extractText(response);

            this.conversation.push({
                role: 'assistant',
                content: assistantText,
                type: 'message'
            });

            return {
                text: assistantText,
                response
            };
        } catch (error) {
            // Remove the user entry if the request failed so we do not poison the convo history.
            this.conversation.pop();
            throw error;
        }
    }

    private static extractText(response: Response): string {
        if (response.output_text) {
            return response.output_text.trim();
        }

        const segments: string[] = [];
        if (Array.isArray(response.output)) {
            for (const item of response.output) {
                if (item.type !== 'message') {
                    continue;
                }

                for (const content of item.content) {
                    if (content.type === 'output_text' && typeof content.text === 'string') {
                        segments.push(content.text);
                    }
                }
            }
        }
        return segments.join('').trim();
    }
}
