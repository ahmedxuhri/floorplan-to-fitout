import sys
from PIL import Image, ImageFilter, ImageOps, ImageEnhance

def generate_edge_map(input_path, output_path):
    try:
        img = Image.open(input_path).convert('L')
        # Contrast enhancement
        enhancer = ImageEnhance.Contrast(img)
        img = enhancer.enhance(2.0)
        # Find edges
        edges = img.filter(ImageFilter.FIND_EDGES)
        # Invert so background is white and wall/door outlines are crisp black lines
        edges_inv = ImageOps.invert(edges)
        # High-contrast thresholding for clean LineArt
        fn = lambda x: 0 if x < 180 else 255
        lineart = edges_inv.point(fn, mode='1')
        lineart.save(output_path)
        print(f"[edge_map] Edge map generated -> {output_path}")
        return True
    except Exception as e:
        print(f"[edge_map] Error generating edge map: {e}", file=sys.stderr)
        return False

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python3 generate_edge_map.py <input_image> <output_image>")
        sys.exit(1)
    
    inp = sys.argv[1]
    outp = sys.argv[2]
    success = generate_edge_map(inp, outp)
    sys.exit(0 if success else 1)
