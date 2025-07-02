import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, createReadStream, unlinkSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DownloadOptions {
  url: string;
  outputDir?: string;
  quality?: string;
}

class SoundCloudDownloader {
  private outputDir: string;

  constructor(outputDir: string = './downloads') {
    this.outputDir = outputDir;
    this.ensureOutputDirectory();
  }

  private ensureOutputDirectory(): void {
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
      console.log(`Created output directory: ${this.outputDir}`);
    }
  }

  async download(options: DownloadOptions): Promise<{ filePath: string; fileName: string }> {
    const { url, quality = 'best' } = options;
    
    if (!this.isValidSoundCloudUrl(url)) {
      throw new Error('Invalid SoundCloud URL');
    }

    console.log(`Starting download from: ${url}`);

    return new Promise((resolve, reject) => {
      // First, get track info to extract proper filename
      const infoArgs = [
        '--print', '%(uploader)s - %(title)s',
        '--no-download',
        url
      ];

      const infoProcess = spawn('yt-dlp', infoArgs);
      let trackInfo = '';

      infoProcess.stdout.on('data', (data) => {
        trackInfo += data.toString().trim();
      });

      infoProcess.on('close', (infoCode) => {
        if (infoCode !== 0) {
          reject(new Error('Failed to get track information'));
          return;
        }

        // Clean up the filename
        const cleanFileName = this.sanitizeFilename(trackInfo);
        console.log(`Track info: ${cleanFileName}`);

        // Now download with the clean filename
        const outputTemplate = join(this.outputDir, `${cleanFileName}.%(ext)s`);
        
        const downloadArgs = [
          '--extract-audio',
          '--audio-format', 'mp3',
          '--audio-quality', quality,
          '--output', outputTemplate,
          '--no-playlist',
          url
        ];

        const downloadProcess = spawn('yt-dlp', downloadArgs);
        let finalFilePath = '';

        downloadProcess.stdout.on('data', (data) => {
          const output = data.toString().trim();
          console.log(output);
          
          // Look for the final MP3 file
          const match = output.match(/\[ExtractAudio\] Destination: (.+\.mp3)/);
          if (match) {
            finalFilePath = match[1];
            console.log(`Final MP3 file: ${finalFilePath}`);
          }
        });

        downloadProcess.stderr.on('data', (data) => {
          const error = data.toString();
          if (!error.toLowerCase().includes('warning')) {
            console.error('yt-dlp stderr:', error);
          }
        });

        downloadProcess.on('close', (code) => {
          console.log(`Download process exited with code: ${code}`);
          
          if (code === 0) {
            if (finalFilePath && existsSync(finalFilePath)) {
              const fileName = finalFilePath.split('/').pop() || `${cleanFileName}.mp3`;
              console.log(`✅ Download completed: ${fileName}`);
              resolve({ 
                filePath: finalFilePath, 
                fileName: fileName 
              });
            } else {
              // Fallback: search for the file we expect
              const expectedFile = join(this.outputDir, `${cleanFileName}.mp3`);
              if (existsSync(expectedFile)) {
                resolve({
                  filePath: expectedFile,
                  fileName: `${cleanFileName}.mp3`
                });
              } else {
                // Last resort: find most recent MP3 file
                this.findRecentMP3File(resolve, reject);
              }
            }
          } else {
            reject(new Error(`Download failed with exit code ${code}`));
          }
        });

        downloadProcess.on('error', (error) => {
          reject(new Error(`Failed to start download: ${error.message}`));
        });
      });

      infoProcess.on('error', (error) => {
        reject(new Error(`Failed to get track info: ${error.message}`));
      });
    });
  }

  private sanitizeFilename(filename: string): string {
    // Remove or replace invalid filename characters
    return filename
      .replace(/[<>:"/\\|?*]/g, '') // Remove invalid characters
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/\.{2,}/g, '.') // Replace multiple dots with single dot
      .trim() // Remove leading/trailing whitespace
      .substring(0, 200); // Limit length to prevent filesystem issues
  }

  private findRecentMP3File(resolve: Function, reject: Function): void {
    try {
      const files = readdirSync(this.outputDir);
      const mp3Files = files.filter((f: string) => f.endsWith('.mp3'));
      
      if (mp3Files.length > 0) {
        const recentFile = mp3Files
          .map((f: string) => ({
            name: f,
            path: join(this.outputDir, f),
            mtime: statSync(join(this.outputDir, f)).mtime
          }))
          .sort((a: { mtime: Date }, b: { mtime: Date }) => b.mtime.getTime() - a.mtime.getTime())[0];
        
        console.log(`Found recent MP3 file: ${recentFile.name}`);
        resolve({
          filePath: recentFile.path,
          fileName: recentFile.name
        });
      } else {
        reject(new Error('No MP3 files found in downloads directory'));
      }
    } catch (error) {
      reject(new Error(`File search failed: ${error}`));
    }
  }

  private isValidSoundCloudUrl(url: string): boolean {
    const soundcloudRegex = /^https?:\/\/(www\.)?soundcloud\.com\/.+/;
    return soundcloudRegex.test(url);
  }

  private isPlaylistUrl(url: string): boolean {
    return url.includes('/sets/');
  }

  async downloadPlaylist(options: DownloadOptions & { downloadId?: string }): Promise<{ zipPath: string; fileName: string }> {
    const { url, quality = 'best', downloadId } = options;
    
    if (!this.isValidSoundCloudUrl(url) || !this.isPlaylistUrl(url)) {
      throw new Error('Invalid SoundCloud playlist URL');
    }

    console.log(`Starting playlist download from: ${url}`);

    return new Promise((resolve, reject) => {
      // First, get playlist info including track count
      const infoArgs = [
        '--print', '%(playlist_title)s',
        '--print', '%(playlist_count)s',
        '--flat-playlist',
        '--no-download',
        url
      ];

      const infoProcess = spawn('yt-dlp', infoArgs);
      let infoOutput = '';

      infoProcess.stdout.on('data', (data) => {
        infoOutput += data.toString();
      });

      infoProcess.on('close', (infoCode) => {
        if (infoCode !== 0) {
          reject(new Error('Failed to get playlist information'));
          return;
        }

        const lines = infoOutput.trim().split('\n').filter(line => line.trim());
        const playlistTitle = lines[0] || 'SoundCloud_Playlist';
        const playlistCount = parseInt(lines[1]) || 0;

        if (downloadId) {
          sendProgress(downloadId, {
            type: 'playlist_info',
            title: playlistTitle,
            totalTracks: playlistCount
          });
        }

        const cleanPlaylistName = this.sanitizeFilename(playlistTitle);
        const playlistDir = join(this.outputDir, cleanPlaylistName);
        
        // Create playlist directory
        if (!existsSync(playlistDir)) {
          mkdirSync(playlistDir, { recursive: true });
        }

        console.log(`Playlist: ${cleanPlaylistName} (${playlistCount} tracks)`);

        // Download all tracks in playlist
        const outputTemplate = join(playlistDir, '%(playlist_index)02d - %(uploader)s - %(title)s.%(ext)s');
        
        const downloadArgs = [
          '--extract-audio',
          '--audio-format', 'mp3',
          '--audio-quality', quality,
          '--output', outputTemplate,
          '--yes-playlist',
          '--print', 'after_move:%(filepath)s',
          url
        ];

        const downloadProcess = spawn('yt-dlp', downloadArgs);
        let completedTracks = 0;
        let currentTrack = '';

        downloadProcess.stdout.on('data', (data) => {
          const output = data.toString();
          console.log(output);
          
          // Track current download
          const downloadMatch = output.match(/\[download\]\s+(\d+(?:\.\d+)?%)\s+of\s+[^\s]+\s+at\s+[^\s]+\s+ETA\s+[^\s]+.*?(.+?)(?:\s+\(frag|$)/);
          if (downloadMatch) {
            const percentage = downloadMatch[1];
            if (downloadId) {
              sendProgress(downloadId, {
                type: 'track_progress',
                currentTrack: completedTracks + 1,
                totalTracks: playlistCount,
                trackProgress: percentage,
                trackName: currentTrack
              });
            }
          }

          // Extract current track info
          const trackMatch = output.match(/\[soundcloud\]\s+[^:]+:\s+Downloading\s+info\s+JSON/);
          if (trackMatch) {
            const urlMatch = output.match(/\[soundcloud\]\s+([^:]+):/);
            if (urlMatch) {
              currentTrack = urlMatch[1].replace(/[_-]/g, ' ');
            }
          }

          // Count completed tracks
          if (output.includes('[ExtractAudio] Destination:')) {
            completedTracks++;
            if (downloadId) {
              sendProgress(downloadId, {
                type: 'track_completed',
                completedTracks: completedTracks,
                totalTracks: playlistCount,
                trackName: currentTrack
              });
            }
          }
        });

        downloadProcess.stderr.on('data', (data) => {
          const error = data.toString();
          if (!error.toLowerCase().includes('warning')) {
            console.error('yt-dlp stderr:', error);
          }
        });

        downloadProcess.on('close', (code) => {
          console.log(`Playlist download process exited with code: ${code}`);
          
          if (code === 0) {
            console.log(`✅ Downloaded ${completedTracks} tracks`);
            
            if (downloadId) {
              sendProgress(downloadId, {
                type: 'creating_zip',
                message: 'Creating ZIP file...'
              });
            }
            
            // Create ZIP file
            this.createPlaylistZip(playlistDir, cleanPlaylistName)
              .then((zipPath) => {
                if (downloadId) {
                  sendProgress(downloadId, {
                    type: 'completed',
                    message: 'Download ready!'
                  });
                }
                resolve({
                  zipPath: zipPath,
                  fileName: `${cleanPlaylistName}.zip`
                });
              })
              .catch((zipError) => {
                reject(new Error(`Failed to create ZIP: ${zipError.message}`));
              });
          } else {
            reject(new Error(`Playlist download failed with exit code ${code}`));
          }
        });

        downloadProcess.on('error', (error) => {
          reject(new Error(`Failed to start playlist download: ${error.message}`));
        });
      });

      infoProcess.on('error', (error) => {
        reject(new Error(`Failed to get playlist info: ${error.message}`));
      });
    });
  }

  private async createPlaylistZip(playlistDir: string, playlistName: string): Promise<string> {
    const archiver = require('archiver');
    const fs = require('fs');
    
    const zipPath = join(this.outputDir, `${playlistName}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise((resolve, reject) => {
      output.on('close', () => {
        console.log(`ZIP created: ${archive.pointer()} total bytes`);
        // Clean up playlist directory after zipping
        setTimeout(() => {
          try {
            fs.rmSync(playlistDir, { recursive: true, force: true });
            console.log(`Cleaned up directory: ${playlistDir}`);
          } catch (error) {
            console.error(`Failed to clean up directory: ${error}`);
          }
        }, 1000);
        resolve(zipPath);
      });

      archive.on('error', (err: Error) => {
        reject(err);
      });

      archive.pipe(output);
      archive.directory(playlistDir, false);
      archive.finalize();
    });
  }
}

// Express server setup
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from public directory

// Initialize downloader
const downloader = new SoundCloudDownloader();

// Store active downloads for progress tracking
const activeDownloads = new Map();

// Server-Sent Events endpoint for progress updates
app.get('/api/progress/:downloadId', (req, res) => {
  const downloadId = req.params.downloadId;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send initial connection
  res.write('data: {"type":"connected"}\n\n');

  // Store this connection
  if (!activeDownloads.has(downloadId)) {
    activeDownloads.set(downloadId, []);
  }
  activeDownloads.get(downloadId).push(res);

  // Clean up on disconnect
  req.on('close', () => {
    const connections = activeDownloads.get(downloadId);
    if (connections) {
      const index = connections.indexOf(res);
      if (index !== -1) {
        connections.splice(index, 1);
      }
      if (connections.length === 0) {
        activeDownloads.delete(downloadId);
      }
    }
  });
});

// Function to send progress updates
function sendProgress(downloadId: string, data: any) {
  const connections = activeDownloads.get(downloadId);
  if (connections) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    connections.forEach(res => {
      try {
        res.write(message);
      } catch (error) {
        console.error('Error sending progress:', error);
      }
    });
  }
}

// API Routes
app.post('/api/download', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Download request for: ${url}`);
    
    // Generate unique download ID for progress tracking
    const downloadId = Math.random().toString(36).substring(2, 15);
    
    // Check if it's a playlist
    if (url.includes('/sets/')) {
      // Return download ID immediately for progress tracking
      res.json({ downloadId, type: 'playlist' });
      
      // Start playlist download in background
      try {
        const { zipPath, fileName } = await downloader.downloadPlaylist({ url, downloadId });
        
        // Store result for later retrieval
        activeDownloads.set(`${downloadId}_result`, { zipPath, fileName, type: 'playlist' });
        
        sendProgress(downloadId, {
          type: 'ready_for_download',
          downloadId: downloadId
        });
      } catch (error) {
        sendProgress(downloadId, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Download failed'
        });
      }
    } else {
      // Handle single track download (immediate response)
      const { filePath, fileName } = await downloader.download({ url });
      
      // Stream the file to the client
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      
      const fileStream = createReadStream(filePath);
      
      fileStream.on('end', () => {
        // Clean up the file after sending
        setTimeout(() => {
          try {
            unlinkSync(filePath);
            console.log(`Cleaned up file: ${filePath}`);
          } catch (error) {
            console.error(`Failed to clean up file: ${error}`);
          }
        }, 1000);
      });
      
      fileStream.pipe(res);
    }
    
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Download failed' 
    });
  }
});

// Endpoint to retrieve completed downloads
app.get('/api/download/:downloadId', async (req, res) => {
  try {
    const downloadId = req.params.downloadId;
    const result = activeDownloads.get(`${downloadId}_result`);
    
    if (!result) {
      return res.status(404).json({ error: 'Download not found or not ready' });
    }

    const { zipPath, fileName } = result;
    
    // Stream the ZIP file to the client
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    
    const fileStream = createReadStream(zipPath);
    
    fileStream.on('end', () => {
      // Clean up the ZIP file and result after sending
      setTimeout(() => {
        try {
          unlinkSync(zipPath);
          activeDownloads.delete(`${downloadId}_result`);
          console.log(`Cleaned up ZIP file: ${zipPath}`);
        } catch (error) {
          console.error(`Failed to clean up ZIP file: ${error}`);
        }
      }, 1000);
    });
    
    fileStream.pipe(res);
    
  } catch (error) {
    console.error('Download retrieval error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Download retrieval failed' 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🎵 SoundCloud MP3 Downloader Server`);
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Downloads directory: ./downloads`);
  console.log(`\n💡 Open http://localhost:${PORT} in your browser to use the web interface`);
});

export default app;