/**
 * TODO TOOL — task list management.
 *
 * Tool name matches Hermes: todo.
 * Manages an in-memory task list for the current session.
 */
import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export const todoToolSpecs: ToolSpec[] = [
  {
    name: 'todo',
    description: 'Manage task list. Read current list or create/update items.',
    parameters: obj(
      {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
            },
          },
          description: 'Task items to write. Omit to read current list.',
        },
        merge: { type: 'boolean', description: 'true: update existing, false: replace all (default false)' },
      },
      [],
    ),
  },
];

export function createTodoToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  let todos: TodoItem[] = [];

  handlers.set('todo', async (args): Promise<ToolResult> => {
    const newTodos = args.todos as TodoItem[] | undefined;
    const merge = (args.merge as boolean) ?? false;

    if (!newTodos) {
      // Read current list
      if (todos.length === 0) {
        return { ok: true, output: '(no tasks)' };
      }
      const output = todos.map((t) => {
        const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : t.status === 'cancelled' ? '❌' : '⏳';
        return `${icon} [${t.id}] ${t.content} (${t.status})`;
      }).join('\n');
      return { ok: true, output };
    }

    if (merge) {
      // Update existing items by id, add new ones
      for (const item of newTodos) {
        const existing = todos.findIndex((t) => t.id === item.id);
        if (existing >= 0) {
          todos[existing] = { ...todos[existing], ...item };
        } else {
          todos.push(item);
        }
      }
    } else {
      // Replace all
      todos = [...newTodos];
    }

    const output = todos.map((t) => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : t.status === 'cancelled' ? '❌' : '⏳';
      return `${icon} [${t.id}] ${t.content} (${t.status})`;
    }).join('\n');

    return { ok: true, output: `Updated task list:\n${output}` };
  });

  return handlers;
}
