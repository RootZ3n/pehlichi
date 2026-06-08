// Main TUI App — the agent's terminal interface
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { loadSkin, type Skin } from './lib/skin.js';
import { ChatSession, type ChatMessage } from './lib/chat.js';

// ── Banner ───────────────────────────────────────────────────────────
function Banner({ skin }: { skin: Skin }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={skin.colors.banner_border} paddingX={1}>
      <Text>{skin.banner_logo}</Text>
      <Text>{skin.banner_hero}</Text>
    </Box>
  );
}

// ── Status Line ──────────────────────────────────────────────────────
function StatusLine({ skin, status, elapsed }: { skin: Skin; status: string; elapsed: string }) {
  const statusColor = status === 'ready'
    ? skin.colors.status_good
    : status.includes('thinking') || status.includes('contemplates') || status.includes('squirreling') || status.includes('mothership')
      ? skin.colors.status_warn
      : status === 'error'
        ? skin.colors.status_bad
        : skin.colors.status_fg;

  return (
    <Box borderStyle="single" borderColor={skin.colors.muted} paddingX={1}>
      <Text color={skin.colors.muted}>{skin.branding.agent_name}</Text>
      <Text color={skin.colors.muted}> │ </Text>
      <Text color={statusColor} bold>{status}</Text>
      <Text color={skin.colors.muted}> │ </Text>
      <Text color={skin.colors.muted}>{elapsed}</Text>
    </Box>
  );
}

// ── Thinking Indicator ───────────────────────────────────────────────
function ThinkingIndicator({ skin, verb }: { skin: Skin; verb: string }) {
  const face = skin.spinner.thinking_faces[0] ?? '⠋';
  const wing = skin.spinner.wings[0] ?? ['▸', '◂'];
  return (
    <Box paddingX={1}>
      <Text color={skin.colors.ui_accent}>
        {wing[0]} {face} {verb}... {wing[1]}
      </Text>
    </Box>
  );
}

// ── Message Bubble ───────────────────────────────────────────────────
function Message({ role, content, skin }: { role: 'user' | 'assistant'; content: string; skin: Skin }) {
  if (role === 'user') {
    return (
      <Box paddingX={1}>
        <Text color={skin.colors.prompt} bold>{skin.branding.prompt_symbol} </Text>
        <Text color={skin.colors.text}>{content}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={skin.colors.response_border} paddingX={1} marginBottom={1}>
      <Text color={skin.colors.ui_accent} bold>{skin.branding.response_label}</Text>
      <Text color={skin.colors.text}>{content}</Text>
    </Box>
  );
}

// ── Main App ─────────────────────────────────────────────────────────
export default function App() {
  const skin = loadSkin();
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('ready');
  const [thinkingVerb, setThinkingVerb] = useState('');
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState('0s');
  const chatRef = useRef<ChatSession | null>(null);

  // Initialize chat session
  useEffect(() => {
    try {
      chatRef.current = new ChatSession();
    } catch (err) {
      setStatus('error');
      console.error('Failed to initialize chat:', err);
    }
  }, []);

  // Elapsed timer
  useEffect(() => {
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      if (secs < 60) setElapsed(`${secs}s`);
      else setElapsed(`${Math.floor(secs / 60)}m ${secs % 60}s`);
    }, 1000);
    return () => clearInterval(timer);
  }, [startTime]);

  // Ctrl+C to exit
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      exit();
    }
  });

  const handleSubmit = useCallback(async (value: string) => {
    if (!value.trim() || !chatRef.current) return;

    const userMsg: ChatMessage = {
      role: 'user',
      content: value,
      timestamp: Date.now(),
    };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');

    // Show thinking with agent-specific verb
    const verbs = skin.spinner.thinking_verbs;
    const verb = verbs[Math.floor(Math.random() * verbs.length)] ?? 'thinking';
    setThinkingVerb(verb);
    setStatus(verb);

    try {
      const response = await chatRef.current.send(value);

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content,
        timestamp: Date.now(),
      };
      setMessages([...newMessages, assistantMsg]);
      setStatus('ready');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorChatMsg: ChatMessage = {
        role: 'assistant',
        content: `[Error: ${errorMsg}]`,
        timestamp: Date.now(),
      };
      setMessages([...newMessages, errorChatMsg]);
      setStatus('error');
    }
  }, [messages, skin]);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Banner */}
      <Banner skin={skin} />

      {/* Welcome message */}
      <Box paddingX={1} paddingTop={1}>
        <Text color={skin.colors.ui_accent} italic>{skin.branding.welcome}</Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" paddingTop={1} paddingBottom={1}>
        {messages.filter(m => m.role !== 'system').map((msg, i) => (
          <Message key={i} role={msg.role as 'user' | 'assistant'} content={msg.content} skin={skin} />
        ))}
      </Box>

      {/* Thinking indicator */}
      {status !== 'ready' && status !== 'error' && (
        <ThinkingIndicator skin={skin} verb={thinkingVerb} />
      )}

      {/* Input */}
      <Box paddingX={1}>
        <Text color={skin.colors.prompt} bold>{skin.branding.prompt_symbol} </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type a message..."
        />
      </Box>

      {/* Status line */}
      <Box paddingTop={1}>
        <StatusLine skin={skin} status={status} elapsed={elapsed} />
      </Box>
    </Box>
  );
}
