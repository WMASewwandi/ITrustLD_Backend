import { Router } from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createBlogPost,
  deleteBlogPost,
  listBlogPosts,
  updateBlogPost,
} from '../../services/blog.service.js';
import {
  guessBlogBannerMimeType,
  resolveBlogBannerPath,
} from '../../services/blogStorage.service.js';

export const adminBlogsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

adminBlogsRouter.use(requireAdminAuth);

adminBlogsRouter.get(
  '/',
  requirePermission('manage_blog_posts'),
  async (_req, res, next) => {
    try {
      const blogs = await listBlogPosts();
      res.json({ ok: true, blogs });
    } catch (error) {
      next(error);
    }
  },
);

adminBlogsRouter.get(
  '/banners/:filename',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
    try {
      const filePath = resolveBlogBannerPath(req.params.filename);
      const buffer = await fs.readFile(filePath);
      res.setHeader('Content-Type', guessBlogBannerMimeType(req.params.filename));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buffer);
    } catch (error) {
      if (error.code === 'ENOENT') {
        const notFound = new Error('Banner not found.');
        notFound.status = 404;
        next(notFound);
        return;
      }
      next(error);
    }
  },
);

adminBlogsRouter.post(
  '/',
  requirePermission('manage_blog_posts'),
  upload.single('blog_banner'),
  async (req, res, next) => {
    try {
      const blog = await createBlogPost({
        title: req.body?.blog_title,
        description: req.body?.blog_description,
        bannerFile: req.file,
      });
      res.status(201).json({ ok: true, blog });
    } catch (error) {
      if (error instanceof multer.MulterError) {
        const limitError = new Error(
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Banner image must not exceed 2MB.'
            : error.message,
        );
        limitError.status = 422;
        next(limitError);
        return;
      }
      next(error);
    }
  },
);

adminBlogsRouter.post(
  '/:blogId/update',
  requirePermission('manage_blog_posts'),
  upload.single('blog_banner'),
  async (req, res, next) => {
    try {
      const blog = await updateBlogPost({
        blogId: Number(req.params.blogId),
        title: req.body?.blog_title,
        description: req.body?.blog_description,
        publishedState: req.body?.is_published,
        bannerFile: req.file ?? null,
      });
      res.json({ ok: true, blog });
    } catch (error) {
      if (error instanceof multer.MulterError) {
        const limitError = new Error(
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Banner image must not exceed 2MB.'
            : error.message,
        );
        limitError.status = 422;
        next(limitError);
        return;
      }
      next(error);
    }
  },
);

adminBlogsRouter.post(
  '/:blogId/delete',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
    try {
      const result = await deleteBlogPost(Number(req.params.blogId));
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);
