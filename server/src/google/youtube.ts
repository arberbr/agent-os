import { Readable } from 'node:stream';
import { google } from 'googleapis';
import type { Auth, youtube_v3 } from 'googleapis';
import { googleErrorMessage } from './auth.js';
import { driveGetFileContent } from './drive.js';

// ── YouTube Data API v3 ─────────────────────────────────────────────────

export interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: string;
  likeCount: string;
  commentCount: string;
  url: string;
  thumbnail: string;
}

function simplifyVideo(item: youtube_v3.Schema$Video): YouTubeVideo {
  const id = item.id ?? '';
  return {
    id,
    title: item.snippet?.title ?? '',
    description: item.snippet?.description ?? '',
    channelId: item.snippet?.channelId ?? '',
    channelTitle: item.snippet?.channelTitle ?? '',
    publishedAt: item.snippet?.publishedAt ?? '',
    viewCount: item.statistics?.viewCount ?? '',
    likeCount: item.statistics?.likeCount ?? '',
    commentCount: item.statistics?.commentCount ?? '',
    url: id ? `https://www.youtube.com/watch?v=${id}` : '',
    thumbnail: item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url ?? '',
  };
}

export async function youtubeSearchVideos(
  auth: Auth.OAuth2Client,
  args: { query: string; maxResults?: number },
): Promise<YouTubeVideo[]> {
  try {
    const search = await google.youtube({ version: 'v3', auth }).search.list({
      part: ['snippet'],
      q: args.query,
      type: ['video'],
      maxResults: Math.min(args.maxResults ?? 5, 25),
    });
    const ids = (search.data.items ?? [])
      .map((i) => (typeof i.id === 'string' ? i.id : i.id?.videoId))
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return [];

    const details = await google.youtube({ version: 'v3', auth }).videos.list({
      part: ['snippet', 'statistics'],
      id: ids,
    });
    return (details.data.items ?? []).map(simplifyVideo);
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function youtubeGetVideo(auth: Auth.OAuth2Client, videoId: string): Promise<YouTubeVideo> {
  try {
    const res = await google.youtube({ version: 'v3', auth }).videos.list({
      part: ['snippet', 'statistics', 'contentDetails'],
      id: [videoId],
    });
    const item = res.data.items?.[0];
    if (!item) throw new Error(`Video ${videoId} not found.`);
    return simplifyVideo(item);
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/** List videos on the authenticated user's own channel. */
export async function youtubeListMyVideos(auth: Auth.OAuth2Client, args: { maxResults?: number }): Promise<YouTubeVideo[]> {
  try {
    const channel = await google.youtube({ version: 'v3', auth }).channels.list({ part: ['contentDetails'], mine: true });
    const uploadsPlaylist = channel.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylist) throw new Error('No YouTube channel found for this account.');
    const items = await google.youtube({ version: 'v3', auth }).playlistItems.list({
      part: ['snippet'],
      playlistId: uploadsPlaylist,
      maxResults: Math.min(args.maxResults ?? 10, 50),
    });
    const ids = (items.data.items ?? [])
      .map((i) => i.snippet?.resourceId?.videoId)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return [];
    const details = await google.youtube({ version: 'v3', auth }).videos.list({ part: ['snippet', 'statistics'], id: ids });
    return (details.data.items ?? []).map(simplifyVideo);
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/**
 * Upload a video to the user's channel. Video bytes come either from a Drive
 * file (driveFileId, read with the workspace grant's client) or directly as
 * base64 (contentBase64). Uses a resumable upload, as required by the YouTube
 * API.
 */
export async function youtubeUploadVideo(
  auth: Auth.OAuth2Client,
  args: { title: string; description?: string; driveFileId?: string; contentBase64?: string; mimeType?: string; tags?: string[]; privacyStatus?: 'private' | 'unlisted' | 'public' },
  driveAuth?: Auth.OAuth2Client | null,
): Promise<{ videoId: string; url: string }> {
  try {
    let buffer: Buffer;
    let mimeType = args.mimeType ?? 'video/mp4';
    if (args.driveFileId) {
      if (!driveAuth) {
        throw new Error('Reading the video from Drive requires the Google Workspace group to be connected (Integrations → Gmail · Calendar · Drive).');
      }
      const file = await driveGetFileContent(driveAuth, { fileId: args.driveFileId });
      if (!file.contentBase64) throw new Error(`Drive file ${args.driveFileId} has no downloadable content.`);
      buffer = Buffer.from(file.contentBase64, 'base64');
      mimeType = file.mimeType || mimeType;
    } else if (args.contentBase64) {
      buffer = Buffer.from(args.contentBase64, 'base64');
    } else {
      throw new Error('Provide either driveFileId or contentBase64 with the video bytes.');
    }

    const res = await google.youtube({ version: 'v3', auth }).videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: args.title.slice(0, 100),
          description: (args.description ?? '').slice(0, 5000),
          tags: args.tags,
        },
        status: { privacyStatus: args.privacyStatus ?? 'private' },
      },
      media: { mimeType, body: Readable.from(buffer) },
    });
    const videoId = res.data.id ?? '';
    return { videoId, url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '' };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}
