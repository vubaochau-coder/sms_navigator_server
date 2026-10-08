/// <reference types="jest" />

import request from 'supertest';
import { createApp } from '../src/app.js';

describe('Health Endpoints & Rate Limiting', () => {
  const app = createApp();

  it('GET /health returns 200 with status healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.timestamp).toBeDefined();
    expect(typeof res.body.firebaseConnected).toBe('boolean');
  });

  it('GET /api/v1/health returns 200 with status healthy (backwards compatibility alias)', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(typeof res.body.uptime).toBe('number');
  });
});
