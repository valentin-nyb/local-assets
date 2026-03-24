import re

try:
    user_html = open('/tmp/html.html').read()
    dash_html = open('dashboard.html').read()

    main_match = re.search(r'<main[^>]*>(.*?)</main>', user_html, re.DOTALL)
    script_match = re.search(r'<script>(.*?)</script>', user_html, re.DOTALL)
    style_match = re.search(r'<style>(.*?)</style>', user_html, re.DOTALL)

    main_content = main_match.group(1) if main_match else ''
    script_content = script_match.group(1) if script_match else ''
    user_styles = style_match.group(1) if style_match else ''

    header_part = dash_html.split('<main')[0]
    header_part = header_part.replace('</head>', f'<style>{user_styles}</style>\n</head>')

    flatpickr_links = '''
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/themes/dark.css">
        <script src="https://cdn.jsdelivr.net/npm/flatpickr"></script>
        <script src="https://cdn.jsdelivr.net/npm/@mux/mux-player"></script>
    '''
    header_part = header_part.replace('</head>', f'{flatpickr_links}\n</head>')

    final_html = f"{header_part}<main class=\"flex-1 flex flex-col overflow-hidden relative bg-background\">\n{main_content}\n</main>\n<script>\n{script_content}\n</script>\n</body>\n</html>"

    with open('assets.html', 'w') as f:
        f.write(final_html)
    print("✅ assets.html rebuilt successfully.")
except Exception as e:
    print(f"❌ Error: {e}")
