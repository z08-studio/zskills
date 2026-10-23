import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from 'express';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createHttpServer, type Server } from 'node:http';
import { ServiceError, SkillsService } from './service.js';

function localHost(hostHeader: string | undefined): boolean {
  return Boolean(
    hostHeader &&
    /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(hostHeader),
  );
}

const protectLocalAccess: RequestHandler = (request, response, next) => {
  if (!localHost(request.headers.host)) {
    response.status(403).json({
      error: 'Use localhost or 127.0.0.1 to connect to this service.',
    });
    return;
  }
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin) {
      let sameOrigin = false;
      try {
        const parsed = new URL(origin);
        sameOrigin =
          parsed.host === request.headers.host && parsed.protocol === 'http:';
      } catch {
        /* Reject malformed origins. */
      }
      if (!sameOrigin) {
        response
          .status(403)
          .json({ error: 'Requests must come from this service origin.' });
        return;
      }
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      response
        .status(403)
        .json({ error: 'Cross-site requests are not allowed.' });
      return;
    }
    if (!request.is('application/json')) {
      response
        .status(415)
        .json({ error: 'API changes require application/json.' });
      return;
    }
  }
  next();
};

export function createApp(service = new SkillsService()): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(protectLocalAccess);
  app.use('/api', express.json({ limit: '16kb' }));
  app.use('/api', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/workspace', async (_request, response) => {
    response.json(await service.getWorkspace());
  });
  app.post('/api/rescan', async (_request, response) => {
    response.json(await service.rescan());
  });
  app.get('/api/skills/:id', async (request, response) => {
    response.json(await service.getSkill(request.params.id));
  });
  app.get('/api/skills/:id/file', async (request, response) => {
    if (typeof request.query.path !== 'string')
      throw new ServiceError(400, 'Choose a file path.');
    response.json(await service.getFile(request.params.id, request.query.path));
  });
  app.post('/api/roots', async (request, response) => {
    response.json(await service.addRoot(request.body?.path));
  });
  app.delete('/api/roots/:id', async (request, response) => {
    response.json(await service.removeRoot(request.params.id));
  });
  app.put('/api/editor', async (request, response) => {
    response.json(await service.setEditor(request.body?.editor));
  });
  app.post('/api/skills/:id/open', async (request, response) => {
    response.json(
      await service.openEditor(
        request.params.id,
        request.body?.scope,
        request.body?.path,
      ),
    );
  });
  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'API endpoint not found.' });
  });
  const handleError: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next,
  ) => {
    if (error instanceof ServiceError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({ error: 'Invalid JSON request.' });
      return;
    }
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      error.status === 413
    ) {
      response
        .status(413)
        .json({ error: 'The request exceeds the size limit.' });
      return;
    }
    console.error('ZSkills request failed:', error);
    response.status(500).json({
      error:
        'The host could not complete this request. Rescan or check the service logs.',
    });
  };
  app.use(handleError);
  return app;
}

export async function startServer(): Promise<Server> {
  const app = createApp();
  const server = createHttpServer(app);
  const port = Number(process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer between 1 and 65535.');
  if (process.env.NODE_ENV === 'production') {
    const clientRoot = path.resolve(process.cwd(), 'dist/client');
    app.use(express.static(clientRoot));
    app.get('/{*path}', (_request, response) => {
      response.sendFile(path.join(clientRoot, 'index.html'));
    });
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`ZSkills is available at http://localhost:${port}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
