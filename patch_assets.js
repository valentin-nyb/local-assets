const fs = require('fs');

const userHtml = fs.readFileSync('/tmp/html.html', 'utf-8');
const dashHtml = fs.readFileSync('dashboard.html', 'utf-8');

const mainMatch = userHtml.match(/<main[^>]*>[\s\S]*?<\/main>/);
const scriptMatch = userHtml.match(/<script>[\s\S]*?<\/script>/);
const styleMatch = userHtml.match(/<style>[\s\S]*?<\/style>/);

const mainContent = mainMatch ? mainMatch[0] : '';
let scriptContent = scriptMatch ? scriptMatch[0] : '';
const userStyles = styleMatch ? styleMatch[1] : '';

let headerPart = dashHtml.split('<main')[0];

headerPart = headerPart.replace('</head>', `<style>${userStyles}</style>\n</head>`);

const flatpickrLinks = `
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/themes/dark.css">
    <script src="https://cdn.jsdelivr.net/npm/flatpickr"></script>
    <script src="https://cdn.jsdelivr.net/npm/@mux/mux-player"></script>const fs = requ= headerPart.repl
const userHtml = fs.reaLinconst dashHtml = fs.readFileSync('dashboard.html', 'utf-8')id
const mainMatch = userHtml.match(/<main[^>]*>[\s\S]*?<\/maar'const scriptMatch = userHtml.match(/<script>[\s\S]*?<\/script>/')const styleMatch = userHtml.match(/<style>[\s\S]*?<\/style>/);

ul
const mainContent = mainMatch ? mainMatch[0] : '';
let scripebalet scriptContent = scriptMatch ? scriptMatch[0] rlconst userStyles = styleMatch ? styleMatch[1] : '';

=>
let headerPart = dashHtml.split('<main')[0];

hea {

headerPart = headerPart.replace('</head>',e-x
const flatpickrLinks = `
    <link rel="stylesheet" href="https://cdn.jsdelivr.netay.    <link rel="styleshe10    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/themes/dark.css">
t}    <script src="https://cdn.jsdelivr.net/npm/flatpickr"></script>
    <script src="h>\n</html>    <script src="https://cdn.jsdelivr.net/npm/@mux/mux-player"></d.html
 cat patch_js.py
 
