import { Router } from 'express';
import { listPublishedBlogPostsForUser } from '../../services/blog.service.js';

export const publicBlogsRouter = Router();

publicBlogsRouter.get('/', async (_req, res, next) => {
  try {
    const posts = await listPublishedBlogPostsForUser();
    res.json({ ok: true, posts, count: posts.length });
  } catch (error) {
    next(error);
  }
});
