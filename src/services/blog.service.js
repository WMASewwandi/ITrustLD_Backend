import { query } from '../config/database.js';
import { formatTimestampSl, formatYmdColombo, parseDbDateTime } from '../utils/slTime.js';
import {
  resolveBlogBannerPublicUrl,
  storeBlogBanner,
  validateBlogBannerUpload,
} from './blogStorage.service.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatTimestamp(value) {
  if (!value) return '';
  return formatTimestampSl(value) || String(value);
}

export function mapPublishedState(isPublished) {
  return isPublished ? 'published' : 'not-published';
}

export function parsePublishedState(value) {
  return String(value || '').toLowerCase() === 'published';
}

function toPublicBlog(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    banner: row.banner,
    isPublished: Boolean(row.is_published),
    publishedState: mapPublishedState(Boolean(row.is_published)),
    createdAt: formatTimestamp(row.created_at),
    updatedAt: row.updated_at,
  };
}

async function withBannerUrl(blog) {
  return {
    ...blog,
    bannerUrl: await resolveBlogBannerPublicUrl(blog.banner, blog.updatedAt),
  };
}

function formatDashboardPostDate(value) {
  if (!value) return '';
  const date = parseDbDateTime(value);
  if (!date) return String(value).slice(0, 10);
  return formatYmdColombo(date);
}

async function mapPublishedBlogPostForUser(row) {
  const title = row.title || '';
  let image = null;
  try {
    image = await resolveBlogBannerPublicUrl(row.banner, row.updated_at);
  } catch {
    image = null;
  }

  return {
    id: row.id,
    title,
    excerpt: row.description || '',
    author: 'iTrustLD',
    initial: title.charAt(0).toUpperCase() || 'i',
    date: formatDashboardPostDate(row.created_at),
    createdAt: row.created_at,
    image,
  };
}

/** Published posts for the user dashboard / public news feed. */
export async function listPublishedBlogPostsForUser(limit = 12) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 12));
  const rows = await query(
    `SELECT id, title, description, banner, created_at, updated_at
     FROM blog_posts
     WHERE is_published = 1
     ORDER BY created_at DESC, id DESC
     LIMIT ${safeLimit}`,
  );

  return Promise.all(rows.map((row) => mapPublishedBlogPostForUser(row)));
}

export async function listBlogPosts() {
  const rows = await query(
    `SELECT id, title, description, banner, is_published, created_at, updated_at
     FROM blog_posts
     ORDER BY id DESC`,
  );
  const blogs = rows.map(toPublicBlog);
  return Promise.all(blogs.map(withBannerUrl));
}

export async function findBlogPostById(blogId) {
  const rows = await query(
    `SELECT id, title, description, banner, is_published, created_at, updated_at
     FROM blog_posts
     WHERE id = ?
     LIMIT 1`,
    [blogId],
  );
  if (!rows[0]) return null;
  return withBannerUrl(toPublicBlog(rows[0]));
}

export async function createBlogPost({ title, description, bannerFile }) {
  const blogTitle = String(title || '').trim();
  const blogDescription = String(description || '').trim();

  if (!blogTitle) {
    throw validationError('Title is required.');
  }
  if (!blogDescription) {
    throw validationError('Description is required.');
  }

  const bannerError = validateBlogBannerUpload(bannerFile);
  if (bannerError) {
    throw validationError(bannerError);
  }

  const banner = await storeBlogBanner(bannerFile);

  const result = await query(
    `INSERT INTO blog_posts (title, description, banner, is_published, created_at, updated_at)
     VALUES (?, ?, ?, 1, NOW(), NOW())`,
    [blogTitle, blogDescription, banner],
  );

  return findBlogPostById(result.insertId);
}

export async function updateBlogPost({
  blogId,
  title,
  description,
  publishedState,
  bannerFile,
}) {
  const existing = await findBlogPostById(blogId);
  if (!existing) {
    throw validationError('Blog post not found.', 404);
  }

  const blogTitle = String(title || '').trim();
  const blogDescription = String(description || '').trim();

  if (!blogTitle) {
    throw validationError('Title is required.');
  }
  if (!blogDescription) {
    throw validationError('Description is required.');
  }

  let banner = existing.banner;
  if (bannerFile) {
    const bannerError = validateBlogBannerUpload(bannerFile);
    if (bannerError) {
      throw validationError(bannerError);
    }
    banner = await storeBlogBanner(bannerFile);
  }

  const isPublished = parsePublishedState(publishedState);

  await query(
    `UPDATE blog_posts
     SET title = ?, description = ?, banner = ?, is_published = ?, updated_at = NOW()
     WHERE id = ?`,
    [blogTitle, blogDescription, banner, isPublished ? 1 : 0, blogId],
  );

  return findBlogPostById(blogId);
}

export async function deleteBlogPost(blogId) {
  const existing = await findBlogPostById(blogId);
  if (!existing) {
    throw validationError('Blog post not found.', 404);
  }

  await query(`DELETE FROM blog_posts WHERE id = ?`, [blogId]);
  return { ok: true, id: blogId };
}
