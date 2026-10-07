// Realtime — Socket.IO rooms user:{id} job:{jobId} provider:{id} ops:dispatch, authorized membership.
import { Server } from 'socket.io';
const io = new Server(3101, { cors: { origin: '*' } });
io.use((socket, next) => {
  const { userId, jobId } = socket.handshake.auth ?? {};
  if (!userId) return next(new Error('UNAUTHORIZED'));
  // authorize room membership: user may join own user room + own jobs only (checked per join)
  (socket.data as { userId: string; jobs: string[] }).userId = String(userId);
  (socket.data as { jobs: string[] }).jobs = jobId ? [String(jobId)] : [];
  next();
});
io.on('connection', (socket) => {
  const userId = (socket.data as { userId: string }).userId;
  socket.join(`user:${userId}`);
  socket.on('job:join', (jobId: string, ack) => {
    const jobs = (socket.data as { jobs: string[] }).jobs ?? [];
    if (!jobs.includes(jobId)) return ack?.({ ok: false, error: 'FORBIDDEN' });
    socket.join(`job:${jobId}`);
    ack?.({ ok: true });
  });
});
export function emitToJob(jobId: string, event: string, payload: unknown) { io.to(`job:${jobId}`).emit(event, payload); }
console.log('kendibo-realtime :3101');
