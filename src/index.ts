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
      // Use yt-dlp output template to get proper artist and title
      const outputTemplate = join(this.outputDir, '%(uploader)s - %(title)s.%(ext)s');
      
      const args = [
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', quality,
        '--output', outputTemplate,
        '--no-playlist',
        '--restrict-filenames', // Remove special characters
        '--print', 'after_move:%(filepath)s', // Print the final file path
        url
      ];

      const ytDlp = spawn('yt-dlp', args);
      let finalFilePath = '';
      let downloadedFile = '';

      ytDlp.stdout.on('data', (data) => {
        const output = data.toString().trim();
        console.log(output);
        
        // Look for the final file path from --print after_move
        if (output.includes(this.outputDir) && output.endsWith('.mp3') && !output.includes('[download]')) {
          finalFilePath = output.trim();
          console.log(`Final file path detected: ${finalFilePath}`);
        }
        
        // Also check for destination in download progress
        const match = output.match(/\[download\] Destination: (.+)/);
        if (match) {
          downloadedFile = match[1].replace(/\.(webm|m4a|mp4)$/, '.mp3');
          console.log(`Download destination: ${downloadedFile}`);
        }

        // Check for post-processing output (after conversion to mp3)
        const postProcessMatch = output.match(/\[ExtractAudio\] Destination: (.+\.mp3)/);
        if (postProcessMatch) {
          finalFilePath = postProcessMatch[1];
          console.log(`Post-process destination: ${finalFilePath}`);
        }
      });

      ytDlp.stderr.on('data', (data) => {
        const error = data.toString();
        // Only log non-warning errors
        if (!error.toLowerCase().includes('warning')) {
          console.error('yt-dlp stderr:', error);
        }
      });

      ytDlp.on('close', (code) => {
        console.log(`yt-dlp process exited with code: ${code}`);
        
        if (code === 0) {
          // Priority: finalFilePath > downloadedFile
          let filePath = finalFilePath || downloadedFile;
          
          console.log(`Checking file existence: ${filePath}`);
          
          if (filePath && existsSync(filePath)) {
            const fileName = filePath.split('/').pop() || 'track.mp3';
            console.log(`✅ Download completed: ${fileName}`);
            resolve({ 
              filePath: filePath, 
              fileName: fileName 
            });
          } else {
            // If exact path doesn't exist, try to find the file in downloads directory
            console.log('Exact path not found, searching in downloads directory...');
            
            try {
              const files = readdirSync(this.outputDir);
              const mp3Files = files.filter((f: string) => f.endsWith('.mp3'));
              
              if (mp3Files.length > 0) {
                // Get the most recently modified MP3 file
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
              reject(new Error(`File not found after download: ${error}`));
            }
          }
        } else {
          reject(new Error(`Download failed with exit code ${code}`));
        }
      });

      ytDlp.on('error', (error) => {
        reject(new Error(`Failed to start download: ${error.message}`));
      });
    });
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