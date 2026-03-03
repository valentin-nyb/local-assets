import re

with open('assets.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace renderList
old_render_list = r"        function renderList\(\) \{.*?(?=        function playPreview)        \n"
new_render_list = """        function renderList() {
            const list = document.getElementById('cloud-list');
            list.innerHTML = '';
            cloudAssets.forEach(item => {
                const row = document.createElement('div');
                row.className = "p-4 bg-card border border-zinc-800 rounded-3xl group cursor-pointer hover:border-primary/30 transition-all";
                row.innerHTML = `
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-5">
                            <div class="w-12 h-12 bg-zinc-900 flex items-center justify-center rounded-2xl text-primary shrink-0">
                                <iconify-icon icon="solar:play-bold" class="text-xl"></iconify-icon>
                            </div>
                            <div>
                                <div class="flex items-center gap-2 mb-1">
                                    <p class="text-sm font-black uppercase text-white tracking-tight">${item.dj}</p>
                                    <span class="text-[7px] px-1.5 py-0.5 rounded bg-primary text-black font-black font-mono">MASTER</span>
                                </div>
                                <p class="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">
                                    FABRIC LONDON // ${item.date} // ${item.format}
                                </p>
                            </div>
                        </div>
                        <iconify-icon icon="solar:cloud-download-bold" class="text-xl text-zinc-700 group-hover:text-primary transition-colors"></iconify-icon>
                    </div>`;
                row.onclick = () => openPreview(item.url, item.dj, item.format);
                list.appendChild(row);
            });
        }

"""

content = re.sub(old_render_list, new_render_list, content, flags=re.DOTALL)

# Replace setupUploadHandler
old_upload = r"        function setupUploadHandler\(\) \{.*?(?=        function toggleSidebar)        \n"
new_upload = """        function setupUploadHandler() {
            const uploadBtn = document.getElementById('upload-btn');
            
            uploadBtn.onclick = async function() {
                const djName = document.getElementById('ingest-name').value.trim();
                const date = document.getElementById('ingest-date').value.trim();
                const shot = document.getElementById('ingest-shot').value;

                if (!djName || !date) {
                    alert('Please fill in DJ NAME and DATE');
                    return;
                }

                const videoFile = document.getElementById('file-video').files[0];
                const audioFile = document.getElementById('file-audio').files[0];
                const socialFile = document.getElementById('file-social').files[0];
                const marketingFile = document.getElementById('file-marketing').files[0];
                
                const filesToUpload = [
                    { file: videoFile, suffix: shot },
                    { file: audioFile, suffix: "AUDIO" },
                    { file: socialFile, suffix: "SOCIAL" },
                    { file: marketingFile, suffix: "MARKETING" }
                ].filter(f => f.file !== undefined);

                if (filesToUpload.length === 0) {
                    alert('Please select at least one file to upload.');
                    return;
                }

                uploadBtn.disabled = true;
                const originalText = uploadBtn.textContent;

                try {
                    for (let i = 0; i < filesToUpload.length; i++) {
                        const { file, suffix } = filesToUpload[i];
                        uploadBtn.textContent = `AUTHORIZING ${i+1}/${filesToUpload.length}...`;
                        
                        const fileExt = file.name.split('.').pop();
                        const fileName = `venue_masters/${djName.toLowerCase()}_${date.replace(/\s+/g, '_')}_${suffix.toLowerCase()}.${fileExt}`;
                        
                        const authResponse = await fetch(`${CONFIG.WORKER_URL}/presign?file=${fileName}&type=${file.type}`, {
                            headers: { "x-api-key": CONFIG.API_KEY }
                        });
                        const { uploadUrl } = await authResponse.json();

                        uploadBtn.textContent = `UPLOADING ${i+1}/${filesToUpload.length}...`;

                        const uploadResponse = await fetch(uploadUrl, {
                            method: 'PUT',
                            body: file,
                            headers: { 'Content-Type': file.type }
                        });

                        if (!uploadResponse.ok) {
                            throw new Error('Cloudflare upload failed for ' + file.name);
                        }
                    }

                    alert('All uploads successful!');
                    document.getElementById('file-video').value = '';
                    document.getElementById('file-audio').value = '';
                    document.getElementById('file-social').value = '';
                    document.getElementById('file-marketing').value = '';
                    fetchCloudLibrary();
                } catch (err) {
                    console.error('Upload error:', err);
                    alert('Upload error: ' + err.message);
                } finally {
                    uploadBtn.disabled = false;
                    uploadBtn.textContent = originalText;
                }
            };
        }

"""

content = re.sub(old_upload, new_upload, content, flags=re.DOTALL)

# Replace playPreview with openPreview and closePreview
old_play = r"        function playPreview\(url\) \{.*?\n        \}\n"
new_play = """        function openPreview(url, dj, format) {
            const container = document.getElementById('preview-container');
            const player = document.getElementById('preview-video');
            const dlVideo = document.getElementById('dl-video');
            const dlAudio = document.getElementById('dl-audio');
            const title = document.getElementById('vault-dj-title');

            title.textContent = dj;
            dlVideo.href = url;
            dlAudio.href = url.replace('master', 'audio').replace('MOV', 'WAV');

            container.classList.remove('hidden');
            player.src = url;
            player.play();
            container.scrollIntoView({ behavior: 'smooth' });
        }

        function closePreview() {
            const container = document.getElementById('preview-container');
            const player = document.getElementById('preview-video');
            player.pause();
            player.src = '';
            container.classList.add('hidden');
        }
"""

content = re.sub(old_play, new_play, content, flags=re.DOTALL)

with open('assets.html', 'w', encoding='utf-8') as f:
    f.write(content)

