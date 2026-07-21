export {};
import { app, defineCommand } from '@bundled/yaar';
import { state } from './state';
import { basename, sanitizeAlias } from './helpers';
import { navigate, selectFile } from './navigation';
import {
  panelWidth,
  setPanelWidth,
  resetPanelWidth,
  maxPanelWidth,
  MIN_PANEL_WIDTH,
  DEFAULT_PANEL_WIDTH,
} from './layout';
import { navOpen, navPinned, openNav, closeNav, setNavPin } from './navOverlay';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'storage',
    name: 'Storage Browser',
    state: {
      'current-path': {
        description: 'Current directory path being viewed',
        handler: () => state.currentPath,
      },
      'directory-listing': {
        description: 'Files and folders in the current directory',
        handler: () =>
          state.entries.map((e) => ({
            path: e.path,
            name: basename(e.path),
            isDirectory: e.isDirectory,
            size: e.size,
          })),
      },
      'selected-file': {
        description: 'Currently selected file path (null if none)',
        handler: () => state.selectedFile,
      },
      'mount-aliases': {
        description: 'Mounted folders available under mounts/',
        handler: () => [...state.mountAliases],
      },
      'file-preview': {
        description: 'Text content of the currently previewed file (null if not text)',
        handler: () => state.previewContent,
      },
      layout: {
        description:
          'Current layout state. The file preview always fills the whole window as the background; the directory listing lives in a left hover-open overlay panel. navOpen is whether the panel is currently visible, navPinned whether it is pinned open, panelWidth its width in px.',
        handler: () => ({
          navOpen: navOpen(),
          navPinned: navPinned(),
          panelWidth: panelWidth(),
          minPanelWidth: MIN_PANEL_WIDTH,
          maxPanelWidth: maxPanelWidth(),
          defaultPanelWidth: DEFAULT_PANEL_WIDTH,
        }),
      },
    },
    commands: {
      navigate: defineCommand({
        description: 'Navigate to a directory path',
        params: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory path to navigate to' } },
          required: ['path'],
        },
        handler: (params) => {
          navigate(String(params.path));
          return { success: true, path: params.path };
        },
      }),
      'select-file': defineCommand({
        description: 'Select and preview a file',
        params: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path to select' } },
          required: ['path'],
        },
        handler: (params) => {
          const entry = state.entries.find((e) => e.path === params.path);
          if (!entry || entry.isDirectory) return { success: false, error: 'File not found' };
          selectFile(entry);
          return { success: true };
        },
      }),
      'request-mount': defineCommand({
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
        handler: (params) => {
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
      }),
      'set-layout': defineCommand({
        description:
          'Control the left file-list overlay panel. open opens or closes the panel; pinned toggles pin (pinned keeps it open even when the cursor leaves). panelWidth sets the panel width in px (auto-clamped to 300..70% of the window); reset:true restores the default width. Width is persisted and restored on relaunch.',
        params: {
          type: 'object',
          properties: {
            open: { type: 'boolean', description: 'true opens the panel, false closes it' },
            pinned: { type: 'boolean', description: 'true pins the panel open' },
            panelWidth: { type: 'number', description: 'Panel width in px' },
            reset: { type: 'boolean', description: 'true resets panel width to the default' },
          },
        },
        handler: (params) => {
          // Pin first: setNavPin(true) implies open, so an explicit open:false
          // in the same call can still override it.
          if (typeof params.pinned === 'boolean') setNavPin(params.pinned);
          if (params.open === true) openNav();
          else if (params.open === false) closeNav();

          if (params.reset) {
            resetPanelWidth();
          } else if (typeof params.panelWidth === 'number' && Number.isFinite(params.panelWidth)) {
            setPanelWidth(params.panelWidth);
          }
          return { navOpen: navOpen(), navPinned: navPinned(), panelWidth: panelWidth() };
        },
      }),
      refresh: defineCommand({
        description: 'Refresh the current directory listing',
        params: { type: 'object', properties: {} },
        handler: () => {
          navigate(state.currentPath);
          return { success: true };
        },
      }),
    },
  });
}
