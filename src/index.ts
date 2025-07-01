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

// API Routes
app.post('/api/download', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Download request for: ${url}`);
    
    const { filePath, fileName } = await downloader.download({ url });
    
    // Stream the file to the client
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'audio/mpeg');
    
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
    
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Download failed' 
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