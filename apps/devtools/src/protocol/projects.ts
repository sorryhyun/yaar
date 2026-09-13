import { AppCommandError, defineAppCommand } from '@bundled/yaar';
import { activeProject, files } from '../core';
import { createProject, openProject, deleteProject, cloneApp } from '../services';

export const projectCommands = {
  createProject: defineAppCommand({
    description:
      'Create a new project and open it. Scaffolds a working app — one `export default ' +
      'defineApp({...})` with a state key and a Zod-validated command — plus styles.css and ' +
      'an app.json whose `appId` is derived from the name and is legal to deploy under. ' +
      'Returns { projectId, appId, project, files } — `files` being the new file paths.',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
      },
      required: ['name'],
    },
    run: async (p) => {
      const { id, appId } = await createProject(String(p.name));
      const proj = activeProject();
      return {
        projectId: id,
        appId,
        project: proj ? { id: proj.id, name: proj.name } : undefined,
        files: files().map((f) => f.path),
      };
    },
  }),
  openProject: defineAppCommand({
    description: 'Switch to an existing project',
    params: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    run: async (p) => {
      await openProject(String(p.id));
      const proj = activeProject();
      if (!proj) throw new AppCommandError('Project not found');
      return {
        project: { id: proj.id, name: proj.name },
        files: files().map((f) => f.path),
      };
    },
  }),
  deleteProject: defineAppCommand({
    description: 'Permanently delete a project and its files. Not undoable.',
    params: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    run: async (p) => {
      await deleteProject(String(p.id));
    },
  }),
  cloneApp: defineAppCommand({
    description:
      'Clone an installed app source into a new project and open it. The copy is a sandbox: ' +
      'editing it changes nothing about the live app until you deploy. Returns `appId` (from ' +
      'the cloned app.json — the id deploy expects), `files` (the cloned paths), and ' +
      '`agentsMd` with the cloned root AGENTS.md contents, or null when the app has no AGENTS.md.',
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App ID to clone' },
      },
      required: ['appId'],
    },
    run: async (p) => {
      const { id: projectId, appId, agentsMd } = await cloneApp(String(p.appId));
      const proj = activeProject();
      return {
        projectId,
        appId,
        project: proj ? { id: proj.id, name: proj.name } : undefined,
        files: files().map((f) => f.path),
        agentsMd,
      };
    },
  }),
};
