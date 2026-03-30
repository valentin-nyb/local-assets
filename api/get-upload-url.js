// ... top of file stays same ...
    const upload = await mux.video.uploads.create({
      new_asset_settings: { 
        playback_policy: ['public'],
        video_quality: 'plus',
        master_access: 'preview' // <--- ADD THIS LINE for .MOV and .WAV downloads
      },
      cors_origin: '*',
    });
// ... rest of file stays same ...