import re

with open('assets.html', 'r') as f:
    c = f.read()

c = c.replace(
    "var endpoint = (window.location.protocol === 'file:' || window.location.hostname.includes('vercel.app'))\n  ? 'https://local-assets-valentinsmacks-projects.vercel.app/api/get-upload-url'\n  : (window.location.hostname.includes('local-assets.com') ? 'https://local-assets.com/api/get-upload-url' : '/api/get-upload-url');\nvar response = await fetch(endpoint, { method: 'POST' });",
    "var response = await fetch('/api/get-upload-url', { method: 'POST' });"
)
with open('assets.html', 'w') as f:
    f.write(c)

with open('api/get-upload-url.js', 'r') as f:
    c = f.read()

c = c.replace(
    "playback_policy: ['public'],",
    "playback_policy: ['public'],\n        video_quality: 'high_definition'"
)

with open('api/get-upload-url.js', 'w') as f:
    f.write(c)
