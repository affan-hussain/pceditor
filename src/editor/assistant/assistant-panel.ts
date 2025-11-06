import { Panel, Container, TextInput, Button } from '@playcanvas/pcui';

import { AssistantClient } from '../../common/ai/assistant-client.ts';
import { createAssistantTools } from './assistant-tools.ts';

type MessageRole = 'user' | 'assistant';

type MessageHandle = {
    wrapper: HTMLDivElement;
    body: HTMLDivElement;
};

const DEFAULT_ASSISTANT_INSTRUCTIONS = 'You are the PlayCanvas Editor assistant. Provide concise, actionable answers grounded in the current project context. Ask clarifying questions before attempting risky edits.';

editor.once('load', () => {
    const layoutRoot = editor.call('layout.root');
    const assistantClient = new AssistantClient({
        instructions: DEFAULT_ASSISTANT_INSTRUCTIONS,
        tools: createAssistantTools()
    });
    const assistantReady = assistantClient.isReady();

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

    const messageInput = new TextInput({
        keyChange: true,
        blurOnEnter: false,
        placeholder: 'Describe what you need help with...'
    });
    messageInput.class.add('assistant-panel__input');
    inputRow.append(messageInput);

    const sendButton = new Button({
        text: 'Send',
        class: 'assistant-panel__send'
    });
    inputRow.append(sendButton);

    const addMessage = (role: MessageRole, text: string): MessageHandle => {
        const wrapper = document.createElement('div');
        wrapper.classList.add('assistant-panel__message', `assistant-panel__message--${role}`);

        const label = document.createElement('div');
        label.classList.add('assistant-panel__message-label');
        label.textContent = role === 'user' ? 'You' : 'Assistant';
        wrapper.appendChild(label);

        const body = document.createElement('div');
        body.classList.add('assistant-panel__message-text');
        body.textContent = text;
        wrapper.appendChild(body);

        messages.append(wrapper);
        messages.element.scrollTop = messages.element.scrollHeight;

        return { wrapper, body };
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
        isSending = true;
        setSendingState(true);

        const assistantMessage = addMessage('assistant', 'Thinking...');

        try {
            const result = await assistantClient.send(value);
            assistantMessage.body.textContent = result.text || 'The assistant returned an empty reply.';
        } catch (error) {
            assistantMessage.body.textContent = `Unable to contact the assistant: ${formatError(error)}`;
            assistantMessage.wrapper.classList.add('assistant-panel__message--error');
        } finally {
            isSending = false;
            setSendingState(false);
        }
    };

    sendButton.on('click', sendMessage);

    messageInput.element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void sendMessage();
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

    editor.method('assistant:sendMessage', sendMessage);

    if (assistantReady) {
        addMessage('assistant', 'Hi! I\'m the PlayCanvas assistant. Let me know what you need help with and I\'ll reason over your project.');
    } else {
        sendButton.enabled = false;
        messageInput.readOnly = true;
        addMessage('assistant', 'Assistant backend is not configured. Set OPENAI_* environment variables (e.g. OPENAI_API_KEY) before building to enable this panel.');
    }
});
