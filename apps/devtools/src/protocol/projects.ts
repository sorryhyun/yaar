import { AppCommandError, defineCommand } from '@bundled/yaar';
import {
  activeProject,
  files,
  createProject,
  openProject,
  deleteProject,
  cloneApp,
} from '../project';

export const projectCommands = {
  createProject: defineCommand({
    description: 'Create a new project',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
      },
      required: ['name'],
    },
    handler: async (p) => {
      const id = await createProject(String(p.name));
      return { projectId: id };
    },
  }),
  openProject: defineCommand({
    description: 'Switch to an existing project',
    params: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async (p) => {
      await openProject(String(p.id));
      const proj = activeProject();
      if (!proj) throw new AppCommandError('Project not found');
      return {
        project: { id: proj.id, name: proj.name },
        files: files().map((f) => f.path),
      };
    },
  }),
  deleteProject: defineCommand({
    description: 'Delete a project',
    params: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async (p) => {
      await deleteProject(String(p.id));
    },
  }),
  cloneApp: defineCommand({
    description: 'Clone an installed app source into a new project',
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App ID to clone' },
      },
      required: ['appId'],
    },
    handler: async (p) => {
      const projectId = await cloneApp(String(p.appId));
      const proj = activeProject();
      return {
        projectId,
        project: proj ? { id: proj.id, name: proj.name } : undefined,
        files: files().map((f) => f.path),
      };
    },
  }),
};
