export {};
import { app } from '@bundled/yaar';
import { currentPath, entries, selectedFile, mountAliases, previewContent } from './state';
import { basename, sanitizeAlias } from './helpers';
import { navigate, selectFile } from './navigation';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'storage',
    name: 'Storage Browser',
    state: {
      'current-path': {
        description: 'Current directory path being viewed',
        handler: () => currentPath(),
      },
      'directory-listing': {
        description: 'Files and folders in the current directory',
        handler: () =>
          entries().map((e) => ({
            path: e.path,
            name: basename(e.path),
            isDirectory: e.isDirectory,
            size: e.size,
          })),
      },
      'selected-file': {
        description: 'Currently selected file path (null if none)',
        handler: () => selectedFile(),
      },
      'mount-aliases': {
        description: 'Mounted folders available under mounts/',
        handler: () => [...mountAliases()],
      },
      'file-preview': {
        description: 'Text content of the currently previewed file (null if not text)',
        handler: () => previewContent(),
      },
    },
    commands: {
      navigate: {
        description: 'Navigate to a directory path',
        params: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory path to navigate to' } },
          required: ['path'],
        },
        handler: (params: Record<string, unknown>) => {
          navigate(String(params.path));
          return { success: true, path: params.path };
        },
      },
      'select-file': {
        description: 'Select and preview a file',
        params: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path to select' } },
          required: ['path'],
        },
        handler: (params: Record<string, unknown>) => {
          const entry = entries().find((e) => e.path === params.path);
          if (!entry || entry.isDirectory) return { success: false, error: 'File not found' };
          selectFile(entry);
          return { success: true };
        },
      },
      'request-mount': {
        description: 'Send a mount request for the agent to execute with host permission',
        params: {
          type: 'object',
          properties: {
            alias: { type: 'string', description: 'Mount alias (example: project-files)' },
            hostPath: { type: 'string', description: 'Absolute host folder path' },
            readOnly: { type: 'boolean', description: 'Whether mount should be read-only' },
          },
          required: ['alias', 'hostPath'],
        },
        handler: (params: Record<string, unknown>) => {
          if (!app?.sendInteraction) return { success: false, error: 'Agent bridge unavailable' };
          app.sendInteraction({
            event: 'storage_mount_request',
            source: 'storage',
            alias: sanitizeAlias(String(params.alias || '')),
            hostPath: String(params.hostPath || ''),
            readOnly: Boolean(params.readOnly),
          });
          return { success: true };
        },
      },
      refresh: {
        description: 'Refresh the current directory listing',
        params: { type: 'object', properties: {} },
        handler: () => {
          navigate(currentPath());
          return { success: true };
        },
      },
    },
  });
}
