import { Panel, Container, TextAreaInput, Button } from '@playcanvas/pcui';
import type { ResponseFunctionToolCall, ResponseInputItem } from 'openai/resources/responses/responses';

import { createAssistantTools } from './assistant-tools.ts';
import { AssistantClient } from '../../common/ai/assistant-client.ts';

type MessageRole = 'user' | 'assistant';

type MessageHandle = {
    wrapper: HTMLDivElement;
    body: HTMLDivElement;
};

type MessageOptions = {
    label?: string;
    classes?: string[];
    insertBefore?: HTMLElement | null;
};

const DEFAULT_ASSISTANT_INSTRUCTIONS = 'You are the PlayCanvas Editor assistant. Your job is to answer questions and complete game dev tasks for the user. Do your best with the given tools and try your hardest. Do the simplest thing that works.';
const MAX_INPUT_HEIGHT = 160;
const TOOL_MESSAGE_LABEL = 'Assistant Tool';
const TOOL_RUNNING_CLASS = 'assistant-panel__message--tool-running';
const TOOL_FINISHED_CLASS = 'assistant-panel__message--tool-finished';
const ASSISTANT_DEBUG_KEY = 'editor:assistant:debugLogs';

editor.once('load', () => {
    const layoutRoot = editor.call('layout.root');
    const storedDebugPreference = editor.call('localStorage:get', ASSISTANT_DEBUG_KEY);
    const assistantDebugEnabled = typeof storedDebugPreference === 'boolean' ? storedDebugPreference : true;
    const assistantClient = new AssistantClient({
        instructions: DEFAULT_ASSISTANT_INSTRUCTIONS,
        tools: createAssistantTools(),
        debug: assistantDebugEnabled
    });
    const assistantReady = assistantClient.isReady();

    editor.method('assistant:setDebugLogging', (enabled?: boolean) => {
        if (typeof enabled !== 'boolean') {
            return assistantDebugEnabled;
        }
        editor.call('localStorage:set', ASSISTANT_DEBUG_KEY, enabled);
        console.info(`[Assistant] Debug logging ${enabled ? 'enabled' : 'disabled'}. Reload the editor to apply the new preference.`);
        return enabled;
    });

    if (assistantDebugEnabled) {
        console.info('[Assistant] Debug logging is enabled. See developer tools for full request + tool payloads.');
    }

    if (!layoutRoot) {
        return;
    }

    const storedWidth = editor.call('localStorage:get', 'editor:layout:assistant:width');
    const storedCollapse = editor.call('localStorage:get', 'editor:layout:assistant:collapse');

    const assistantPanel = new Panel({
        id: 'layout-assistant',
        class: ['assistant-panel', 'attributes'],
        collapsed: storedCollapse ?? false,
        collapsible: true,
        collapseHorizontally: true,
        headerText: 'AI ASSISTANT',
        hidden: !editor.call('permissions:read') || editor.call('viewport:expand:state'),
        panelType: 'normal',
        scrollable: true,
        resizable: 'left',
        resizeMin: 256,
        resizeMax: 512,
        width: storedWidth ?? 320
    });
    layoutRoot.append(assistantPanel);

    assistantPanel.on('resize', () => {
        editor.call('localStorage:set', 'editor:layout:assistant:width', assistantPanel.width);
    });
    assistantPanel.on('collapse', () => {
        editor.call('localStorage:set', 'editor:layout:assistant:collapse', true);
    });
    assistantPanel.on('expand', () => {
        editor.call('localStorage:set', 'editor:layout:assistant:collapse', false);
    });

    editor.on('permissions:set', (level) => {
        assistantPanel.hidden = !level || editor.call('viewport:expand:state');
    });

    editor.on('viewport:expand', (state) => {
        assistantPanel.hidden = state;
    });

    assistantPanel.element.addEventListener('mouseover', () => {
        editor.emit('viewport:hover', false);
    }, false);

    editor.method('assistant:panel', () => assistantPanel);

    const container = new Container({
        class: 'assistant-panel__body'
    });

    assistantPanel.append(container);

    const messages = new Container({
        class: 'assistant-panel__messages'
    });
    container.append(messages);

    const inputRow = new Container({
        class: 'assistant-panel__input-row'
    });
    container.append(inputRow);

    const messageInput = new TextAreaInput({
        keyChange: true,
        blurOnEnter: false,
        placeholder: 'Describe what you need help with...',
        resizable: 'none'
    });
    messageInput.class.add('assistant-panel__input');
    inputRow.append(messageInput);

    const getTextArea = () => messageInput.element.querySelector('textarea') as HTMLTextAreaElement | null;

    const adjustInputHeight = () => {
        const textarea = getTextArea();
        if (!textarea) {
            return;
        }
        textarea.style.height = 'auto';
        const contentHeight = textarea.scrollHeight;
        const nextHeight = Math.min(MAX_INPUT_HEIGHT, contentHeight);
        textarea.style.height = `${nextHeight}px`;
        textarea.style.overflowY = contentHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
    };

    const sendButton = new Button({
        text: 'Send',
        class: 'assistant-panel__send'
    });
    inputRow.append(sendButton);

    const addMessage = (role: MessageRole, text: string, options?: MessageOptions): MessageHandle => {
        const wrapper = document.createElement('div');
        wrapper.classList.add('assistant-panel__message', `assistant-panel__message--${role}`);
        if (options?.classes?.length) {
            wrapper.classList.add(...options.classes);
        }

        const label = document.createElement('div');
        label.classList.add('assistant-panel__message-label');
        label.textContent = options?.label || (role === 'user' ? 'You' : 'Assistant');
        wrapper.appendChild(label);

        const body = document.createElement('div');
        body.classList.add('assistant-panel__message-text', 'selectable');
        body.textContent = text;
        wrapper.appendChild(body);

        const target = messages.element;
        if (options?.insertBefore && options.insertBefore.parentElement === target) {
            target.insertBefore(wrapper, options.insertBefore);
        } else {
            target.appendChild(wrapper);
        }
        messages.element.scrollTop = messages.element.scrollHeight;
        adjustInputHeight();

        return { wrapper, body };
    };

    const toolMessages = new Map<string, MessageHandle>();
    let thinkingMessage: MessageHandle | null = null;

    const callId = (call: ResponseFunctionToolCall) => call.call_id || call.id || '';

    const showToolStart = (call: ResponseFunctionToolCall) => {
        const text = `Running ${call.name}`;
        const handle = addMessage('assistant', text, {
            label: TOOL_MESSAGE_LABEL,
            classes: ['assistant-panel__message--tool', TOOL_RUNNING_CLASS],
            insertBefore: thinkingMessage?.wrapper || null
        });
        const id = callId(call);
        if (id) {
            toolMessages.set(id, handle);
        }
    };

    const showToolResult = (call: ResponseFunctionToolCall, _output: ResponseInputItem.FunctionCallOutput) => {
        const id = callId(call);
        const handle = id ? toolMessages.get(id) : undefined;
        const text = `Finished ${call.name}`;
        const message = handle || addMessage('assistant', text, {
            label: TOOL_MESSAGE_LABEL,
            classes: ['assistant-panel__message--tool'],
            insertBefore: thinkingMessage?.wrapper || null
        });
        message.body.textContent = text;
        message.wrapper.classList.remove(TOOL_RUNNING_CLASS);
        message.wrapper.classList.add('assistant-panel__message--tool', TOOL_FINISHED_CLASS);
        if (id) {
            toolMessages.delete(id);
        }
    };

    const formatError = (error: unknown) => {
        if (error instanceof Error) {
            return error.message;
        }
        if (typeof error === 'string' && error.trim().length) {
            return error;
        }
        return 'Unknown error';
    };

    const setSendingState = (sending: boolean) => {
        sendButton.enabled = assistantReady && !sending;
        messageInput.readOnly = sending;
    };

    let isSending = false;

    const sendMessage = async () => {
        if (!assistantReady || isSending) {
            return;
        }

        const value = (messageInput.value || '').trim();
        if (!value) {
            return;
        }

        addMessage('user', value);
        messageInput.value = '';
        adjustInputHeight();
        isSending = true;
        setSendingState(true);

        thinkingMessage = addMessage('assistant', 'Thinking...');
        const assistantMessage = thinkingMessage;

        try {
            const result = await assistantClient.send(value, {
                onToolStart: showToolStart,
                onToolResult: showToolResult
            });
            assistantMessage.body.textContent = result.text || 'The assistant returned an empty reply.';
        } catch (error) {
            assistantMessage.body.textContent = `Unable to contact the assistant: ${formatError(error)}`;
            assistantMessage.wrapper.classList.add('assistant-panel__message--error');
        } finally {
            isSending = false;
            setSendingState(false);
            toolMessages.clear();
            thinkingMessage = null;
        }
    };

    sendButton.on('click', sendMessage);

    messageInput.element.addEventListener('input', adjustInputHeight);

    messageInput.element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    assistantPanel.on('expand', () => {
        setTimeout(() => {
            messageInput.focus(true);
        }, 200);
    });

    if (window.innerWidth <= 720) {
        assistantPanel.folded = true;
    }

    adjustInputHeight();

    editor.method('assistant:sendMessage', sendMessage);

    if (assistantReady) {
        addMessage('assistant', 'Hi! I\'m the PlayCanvas assistant. Let me know what you need help with and I\'ll reason over your project.');
    } else {
        sendButton.enabled = false;
        messageInput.readOnly = true;
        addMessage('assistant', 'Assistant backend is not configured. Set OPENAI_* environment variables (e.g. OPENAI_API_KEY) before building to enable this panel.');
    }
});
