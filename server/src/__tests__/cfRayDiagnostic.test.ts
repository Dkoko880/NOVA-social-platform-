import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cfRayDiagnostic } from '../middleware/cfRayDiagnostic.js';

describe('CF-Ray diagnostic middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs CF-Ray after response finish without query data', async () => {
    const app = express();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    app.use(cfRayDiagnostic);
    app.get('/api/posts', (_req, res) => res.sendStatus(204));

    const response = await request(app)
      .get('/api/posts?token=must-not-be-logged')
      .set('CF-Ray', 'ray-123');

    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    const diagnostic = String(log.mock.calls[0][0]);
    expect(diagnostic).toContain('PATH=/api/posts');
    expect(diagnostic).toContain('STATUS=204');
    expect(diagnostic).toContain('CF-RAY=ray-123');
    expect(diagnostic).not.toContain('must-not-be-logged');
  });
});