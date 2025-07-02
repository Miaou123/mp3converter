import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, createReadStream, unlinkSync, readdirSync, statSync, createWriteStream, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DownloadOptions {
  url: string;
  outputDir?: string;
  quality?: string;
  socketId?: string;
}

interface ProgressData {
  type: 'single' | 'playlist';
  stage: 'info' | 'download' | 'convert' | 'zip' | 'complete' | 'error';
  progress: number;
  currentTrack?: string;
  totalTracks?: number;
  completedTracks?: number;
  message: string;
}

class SoundCloudDownloader {
  private outputDir: string;
  private io: SocketIOServer;

  constructor(outputDir: string = './downloads', io: SocketIOServer) {
    this.outputDir = outputDir;
    this.io = io;
    this.ensureOutputDirectory();
  }

  private ensureOutputDirectory(): void {
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
      console.log(`Created output directory: ${this.outputDir}`);
    }
  }

  private emitProgress(socketId: string, data: ProgressData): void {
    if (socketId) {
      this.io.to(socketId).emit('progress', data);
      console.log(`Progress [${socketId}]: ${data.stage} - ${data.progress}% - ${data.message}`);
    }
  }

  async download(options: DownloadOptions): Promise<{ filePath: string; fileName: string }> {
    const { url, quality = 'best', socketId = '' } = options;
    
    if (!this.isValidSoundCloudUrl(url)) {
      throw new Error('Invalid SoundCloud URL');
    }

    console.log(`Starting download from: ${url}`);
    
    this.emitProgress(socketId, {
      type: 'single',
      stage: 'info',
      progress: 0,
      message: 'Getting track information...'
    });

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
          this.emitProgress(socketId, {
            type: 'single',
            stage: 'error',
            progress: 0,
            message: 'Failed to get track information'
          });
          reject(new Error('Failed to get track information'));
          return;
        }

        // Clean up the filename
        const cleanFileName = this.sanitizeFilename(trackInfo);
        console.log(`Track info: ${cleanFileName}`);

        this.emitProgress(socketId, {
          type: 'single',
          stage: 'download',
          progress: 10,
          message: `Starting download: ${cleanFileName}`,
          currentTrack: cleanFileName
        });

        // Now download with the clean filename
        const outputTemplate = join(this.outputDir, `${cleanFileName}.%(ext)s`);
        
        const downloadArgs = [
          '--extract-audio',
          '--audio-format', 'mp3',
          '--audio-quality', quality,
          '--output', outputTemplate,
          '--no-playlist',
          '--progress',
          url
        ];

        const downloadProcess = spawn('yt-dlp', downloadArgs);
        let finalFilePath = '';
        let isConverting = false;

        downloadProcess.stdout.on('data', (data) => {
          const output = data.toString().trim();
          console.log(output);
          
          // Parse progress from yt-dlp output
          const downloadMatch = output.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
          const extractStartMatch = output.match(/\[ExtractAudio\]/);
          const destinationMatch = output.match(/\[ExtractAudio\] Destination: (.+\.mp3)/);
          const deletingMatch = output.match(/Deleting original file/);
          
          if (downloadMatch) {
            const downloadProgress = parseFloat(downloadMatch[1]);
            this.emitProgress(socketId, {
              type: 'single',
              stage: 'download',
              progress: Math.min(10 + (downloadProgress * 0.7), 80),
              message: `Downloading: ${downloadProgress.toFixed(1)}%`,
              currentTrack: cleanFileName
            });
          } else if (extractStartMatch && !isConverting) {
            isConverting = true;
            this.emitProgress(socketId, {
              type: 'single',
              stage: 'convert',
              progress: 85,
              message: 'Converting to MP3...',
              currentTrack: cleanFileName
            });
          } else if (destinationMatch) {
            finalFilePath = destinationMatch[1];
            console.log(`Final MP3 file: ${finalFilePath}`);
            this.emitProgress(socketId, {
              type: 'single',
              stage: 'convert',
              progress: 95,
              message: 'Conversion completed!',
              currentTrack: cleanFileName
            });
          } else if (deletingMatch) {
            // File cleanup indicates completion
            this.emitProgress(socketId, {
              type: 'single',
              stage: 'complete',
              progress: 100,
              message: 'Download completed!',
              currentTrack: cleanFileName
            });
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
            // Ensure we always emit completion progress
            this.emitProgress(socketId, {
              type: 'single',
              stage: 'complete',
              progress: 100,
              message: 'Download completed!',
              currentTrack: cleanFileName
            });

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
            this.emitProgress(socketId, {
              type: 'single',
              stage: 'error',
              progress: 0,
              message: 'Download failed'
            });
            reject(new Error(`Download failed with exit code ${code}`));
          }
        });

        downloadProcess.on('error', (error) => {
          this.emitProgress(socketId, {
            type: 'single',
            stage: 'error',
            progress: 0,
            message: 'Failed to start download'
          });
          reject(new Error(`Failed to start download: ${error.message}`));
        });
      });

      infoProcess.on('error', (error) => {
        this.emitProgress(socketId, {
          type: 'single',
          stage: 'error',
          progress: 0,
          message: 'Failed to get track info'
        });
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

  async downloadPlaylist(options: DownloadOptions): Promise<{ zipPath: string; fileName: string }> {
    const { url, quality = 'best', socketId = '' } = options;
    
    if (!this.isValidSoundCloudUrl(url) || !this.isPlaylistUrl(url)) {
      throw new Error('Invalid SoundCloud playlist URL');
    }

    console.log(`Starting playlist download from: ${url}`);
    
    this.emitProgress(socketId, {
      type: 'playlist',
      stage: 'info',
      progress: 0,
      message: 'Getting playlist information...'
    });

    return new Promise((resolve, reject) => {
      // First, get playlist info
      const infoArgs = [
        '--print', '%(playlist_title)s',
        '--no-download',
        '--playlist-items', '1',
        url
      ];

      const infoProcess = spawn('yt-dlp', infoArgs);
      let playlistTitle = '';

      infoProcess.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output && !output.includes('WARNING') && !output.includes('ERROR')) {
          playlistTitle = output;
        }
      });

      infoProcess.on('close', (infoCode) => {
        if (infoCode !== 0) {
          console.warn('Could not get playlist title, using fallback');
        }

        // Extract a clean playlist name from URL if title fetch failed
        let cleanPlaylistName = playlistTitle;
        if (!cleanPlaylistName || cleanPlaylistName.trim() === '') {
          const urlParts = url.split('/');
          const setsIndex = urlParts.findIndex(part => part === 'sets');
          if (setsIndex !== -1 && urlParts[setsIndex + 1]) {
            cleanPlaylistName = urlParts[setsIndex + 1]
              .replace(/-/g, ' ')
              .replace(/\?.*$/, '')
              .trim();
          } else {
            cleanPlaylistName = 'SoundCloud_Playlist';
          }
        }

        cleanPlaylistName = this.sanitizeFilename(cleanPlaylistName || 'SoundCloud_Playlist');
        const playlistDir = join(this.outputDir, cleanPlaylistName);
        
        // Create playlist directory
        if (!existsSync(playlistDir)) {
          mkdirSync(playlistDir, { recursive: true });
        }

        console.log(`Playlist: ${cleanPlaylistName}`);
        
        this.emitProgress(socketId, {
          type: 'playlist',
          stage: 'download',
          progress: 5,
          message: `Starting playlist download: ${cleanPlaylistName}`,
          completedTracks: 0
        });

        // Download all tracks in playlist WITHOUT track numbers
        const outputTemplate = join(playlistDir, '%(uploader)s - %(title)s.%(ext)s');
        
        const downloadArgs = [
          '--extract-audio',
          '--audio-format', 'mp3',
          '--audio-quality', quality,
          '--output', outputTemplate,
          '--yes-playlist',
          '--ignore-errors',
          '--progress',
          url
        ];

        const downloadProcess = spawn('yt-dlp', downloadArgs);
        let trackCount = 0;
        let totalTracks = 0;
        let currentTrack = '';
        let isConverting = false;

        downloadProcess.stdout.on('data', (data) => {
          const output = data.toString();
          console.log(output);
          
          // Track total number of tracks
          const playlistMatch = output.match(/\[download\] Downloading item (\d+) of (\d+)/);
          if (playlistMatch) {
            const current = parseInt(playlistMatch[1]);
            totalTracks = parseInt(playlistMatch[2]);
            
            this.emitProgress(socketId, {
              type: 'playlist',
              stage: 'download',
              progress: 5 + ((current - 1) / totalTracks) * 70,
              message: `Downloading track ${current} of ${totalTracks}`,
              currentTrack: currentTrack,
              totalTracks: totalTracks,
              completedTracks: current - 1
            });
          }
          
          // Track current file being downloaded
          const filenameMatch = output.match(/\[download\] Destination: (.+)/);
          if (filenameMatch) {
            const filename = filenameMatch[1].split('/').pop() || '';
            currentTrack = filename.replace(/\.[^/.]+$/, ''); // Remove extension
          }
          
          // Track download progress
          const downloadMatch = output.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
          if (downloadMatch && totalTracks > 0) {
            const downloadProgress = parseFloat(downloadMatch[1]);
            const trackProgress = (trackCount / totalTracks) + (downloadProgress / 100 / totalTracks);
            
            this.emitProgress(socketId, {
              type: 'playlist',
              stage: 'download',
              progress: 5 + (trackProgress * 70),
              message: `Downloading: ${currentTrack} (${downloadProgress.toFixed(1)}%)`,
              currentTrack: currentTrack,
              totalTracks: totalTracks,
              completedTracks: trackCount
            });
          }
          
          // Track conversion and completion
          const extractStartMatch = output.match(/\[ExtractAudio\]/);
          const destinationMatch = output.match(/\[ExtractAudio\] Destination: (.+\.mp3)/);
          const deletingMatch = output.match(/Deleting original file/);
          
          if (extractStartMatch && !isConverting) {
            isConverting = true;
            this.emitProgress(socketId, {
              type: 'playlist',
              stage: 'convert',
              progress: 5 + ((trackCount + 0.8) / Math.max(totalTracks, 1)) * 70,
              message: `Converting: ${currentTrack}`,
              currentTrack: currentTrack,
              totalTracks: totalTracks,
              completedTracks: trackCount
            });
          }
          
          // Count completed tracks - ONLY count when we see the destination (conversion complete)
          if (destinationMatch && isConverting) {
            trackCount++;
            isConverting = false;
            
            this.emitProgress(socketId, {
              type: 'playlist',
              stage: 'download',
              progress: 5 + (trackCount / Math.max(totalTracks, trackCount)) * 70,
              message: `Completed ${trackCount}${totalTracks > 0 ? ` of ${totalTracks}` : ''} tracks`,
              currentTrack: currentTrack,
              totalTracks: totalTracks || trackCount,
              completedTracks: trackCount
            });
          }
          
          // Don't count deletions - they happen after we've already counted the track
        });

        downloadProcess.stderr.on('data', (data) => {
          const error = data.toString();
          if (!error.toLowerCase().includes('warning')) {
            console.error('yt-dlp stderr:', error);
          }
        });

        downloadProcess.on('close', (code) => {
          console.log(`Playlist download process exited with code: ${code}`);
          
          if (code === 0 || trackCount > 0) {
            console.log(`✅ Downloaded ${trackCount} tracks`);
            
            this.emitProgress(socketId, {
              type: 'playlist',
              stage: 'zip',
              progress: 80,
              message: 'Creating ZIP file...',
              totalTracks: totalTracks,
              completedTracks: trackCount
            });
            
            // Clean up any problematic filenames in the directory
            this.cleanupPlaylistFiles(playlistDir);
            
            // Create ZIP file
            this.createPlaylistZip(playlistDir, cleanPlaylistName, socketId)
              .then((zipPath) => {
                this.emitProgress(socketId, {
                  type: 'playlist',
                  stage: 'complete',
                  progress: 100,
                  message: `Playlist ready! Downloaded ${trackCount} tracks`,
                  totalTracks: totalTracks,
                  completedTracks: trackCount
                });
                
                resolve({
                  zipPath: zipPath,
                  fileName: `${cleanPlaylistName}.zip`
                });
              })
              .catch((zipError) => {
                this.emitProgress(socketId, {
                  type: 'playlist',
                  stage: 'error',
                  progress: 0,
                  message: 'Failed to create ZIP file'
                });
                reject(new Error(`Failed to create ZIP: ${zipError.message}`));
              });
          } else {
            this.emitProgress(socketId, {
              type: 'playlist',
              stage: 'error',
              progress: 0,
              message: 'Playlist download failed'
            });
            reject(new Error(`Playlist download failed with exit code ${code}`));
          }
        });

        downloadProcess.on('error', (error) => {
          this.emitProgress(socketId, {
            type: 'playlist',
            stage: 'error',
            progress: 0,
            message: 'Failed to start playlist download'
          });
          reject(new Error(`Failed to start playlist download: ${error.message}`));
        });
      });

      infoProcess.on('error', (error) => {
        this.emitProgress(socketId, {
          type: 'playlist',
          stage: 'error',
          progress: 0,
          message: 'Failed to get playlist info'
        });
        reject(new Error(`Failed to get playlist info: ${error.message}`));
      });
    });
  }

  private cleanupPlaylistFiles(playlistDir: string): void {
    try {
      const files = readdirSync(playlistDir);
      
      files.forEach(file => {
        const filePath = join(playlistDir, file);
        
        // Check if file has problematic naming
        if (file.includes('rawrawtemporaw') || file.length > 200) {
          // Try to extract a cleaner name
          let cleanName = file;
          
          // Remove repetitive patterns
          cleanName = cleanName.replace(/raw+tempo+raw+/gi, '');
          
          // Remove track numbers at the beginning (e.g., "01 - ", "08 - ")
          cleanName = cleanName.replace(/^\d+\s*-\s*/, '');
          
          // Clean up the name
          cleanName = this.sanitizeFilename(cleanName);
          
          // Ensure it has .mp3 extension
          if (!cleanName.endsWith('.mp3')) {
            cleanName += '.mp3';
          }
          
          const newFilePath = join(playlistDir, cleanName);
          
          // Rename the file if the new name is different and doesn't exist
          if (cleanName !== file && !existsSync(newFilePath)) {
            try {
              require('fs').renameSync(filePath, newFilePath);
              console.log(`Renamed: ${file} -> ${cleanName}`);
            } catch (renameError) {
              console.warn(`Could not rename ${file}:`, renameError);
            }
          }
        }
      });
    } catch (error) {
      console.warn('Error cleaning up playlist files:', error);
    }
  }

  private async createPlaylistZip(playlistDir: string, playlistName: string, socketId: string): Promise<string> {
    const zipPath = join(this.outputDir, `${playlistName}.zip`);
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise((resolve, reject) => {
      let progress = 0;
      
      output.on('close', () => {
        console.log(`ZIP created: ${archive.pointer()} total bytes`);
        
        this.emitProgress(socketId, {
          type: 'playlist',
          stage: 'zip',
          progress: 95,
          message: 'ZIP file created, cleaning up...'
        });
        
        // Clean up playlist directory after zipping
        setTimeout(() => {
          try {
            rmSync(playlistDir, { recursive: true, force: true });
            console.log(`Cleaned up directory: ${playlistDir}`);
          } catch (error) {
            console.error(`Failed to clean up directory: ${error}`);
          }
        }, 1000);
        resolve(zipPath);
      });

      archive.on('progress', (progressData) => {
        const newProgress = Math.round((progressData.entries.processed / progressData.entries.total) * 15) + 80;
        if (newProgress > progress) {
          progress = newProgress;
          this.emitProgress(socketId, {
            type: 'playlist',
            stage: 'zip',
            progress: progress,
            message: `Creating ZIP: ${progressData.entries.processed}/${progressData.entries.total} files`
          });
        }
      });

      archive.on('error', (err: Error) => {
        reject(err);
      });

      output.on('error', (err: Error) => {
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
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize downloader
const downloader = new SoundCloudDownloader('./downloads', io);

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// API Routes
app.post('/api/download', async (req, res) => {
  try {
    const { url } = req.body;
    const socketId = req.headers['x-socket-id'] as string;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Download request for: ${url} (Socket: ${socketId})`);
    
    // Check if it's a playlist
    if (url.includes('/sets/')) {
      // Handle playlist download
      const { zipPath, fileName } = await downloader.downloadPlaylist({ url, socketId });
      
      // Stream the ZIP file to the client
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      
      const fileStream = createReadStream(zipPath);
      
      fileStream.on('end', () => {
        // Clean up the ZIP file after sending
        setTimeout(() => {
          try {
            unlinkSync(zipPath);
            console.log(`Cleaned up ZIP file: ${zipPath}`);
          } catch (error) {
            console.error(`Failed to clean up ZIP file: ${error}`);
          }
        }, 1000);
      });
      
      fileStream.on('error', (error) => {
        console.error('File stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'File streaming failed' });
        }
      });
      
      fileStream.pipe(res);
    } else {
      // Handle single track download
      const { filePath, fileName } = await downloader.download({ url, socketId });
      
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
      
      fileStream.on('error', (error) => {
        console.error('File stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'File streaming failed' });
        }
      });
      
      fileStream.pipe(res);
    }
    
  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: error instanceof Error ? error.message : 'Download failed' 
      });
    }
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
server.listen(PORT, () => {
  console.log(`🎵 SoundCloud MP3 Downloader Server`);
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Downloads directory: ./downloads`);
  console.log(`🔌 WebSocket server enabled for real-time progress`);
  console.log(`\n💡 Open http://localhost:${PORT} in your browser to use the web interface`);
});

export default app;