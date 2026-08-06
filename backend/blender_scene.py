"""
ArchVision Blender Scene Builder
Usage: blender --background --python blender_scene.py -- '<json>'
Outputs a JPEG render to output_path specified in the JSON.
Coordinate system: plan X → Blender X, plan Y → Blender Y, height → Blender Z (Z is up in this script)
We use Z-up convention with camera looking horizontally.
"""

import bpy
import sys
import json
import math
import os

# ─── Parse JSON argument ────────────────────────────────────────────────────
argv = sys.argv
try:
    sep  = argv.index("--")
    data = json.loads(argv[sep + 1])
except (ValueError, IndexError, json.JSONDecodeError) as e:
    print(f"[blender_scene] ERROR: {e}")
    sys.exit(1)

walls       = data.get("walls", [])
corners     = data.get("corners", {})
objects     = data.get("objects", [])
floor_w     = data.get("floor_w", 480)    # cm
floor_h     = data.get("floor_h", 1160)   # cm
camera_data = data.get("camera", {})
output_path = data.get("output_path", "/tmp/cad_render.jpg")
wall_height = data.get("wall_height", 250)  # cm
wall_thick  = data.get("wall_thick", 15)    # cm

SCALE = 0.01  # cm → metres

wh = wall_height * SCALE  # wall height in metres
wt = wall_thick  * SCALE  # wall thickness in metres
fw = floor_w * SCALE
fh = floor_h * SCALE

# ─── Reset Scene ────────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.use_freestyle = False

# ─── Helper: apply material ─────────────────────────────────────────────────
def apply_mat(obj, mat):
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)

# ─── PBR Material Factory ───────────────────────────────────────────────────
def _new_pbr(name):
    """Create a material with nodes enabled and return (mat, nodes, links, bsdf)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    return mat, tree.nodes, tree.links, bsdf

def _add_texcoord_mapping(nodes, links):
    """Add TexCoord → Mapping node pair, return Mapping node."""
    tc = nodes.new("ShaderNodeTexCoord")
    mp = nodes.new("ShaderNodeMapping")
    links.new(tc.outputs["Object"], mp.inputs["Vector"])
    return mp

def make_wood_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Wood")
    mp = _add_texcoord_mapping(nodes, links)
    # Noise for grain
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 12.0
    noise.inputs["Detail"].default_value = 6.0
    links.new(mp.outputs["Vector"], noise.inputs["Vector"])
    # Stretch grain via mapping scale
    mp.inputs["Scale"].default_value = (1.0, 8.0, 1.0)
    # ColorRamp for wood tones
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.22, 0.12, 0.05, 1)
    ramp.color_ramp.elements[1].position = 0.65
    ramp.color_ramp.elements[1].color = (0.45, 0.28, 0.12, 1)
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.55
    bsdf.inputs["Specular"].default_value = 0.3
    # Subtle bump
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.15
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat

def make_marble_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Marble")
    mp = _add_texcoord_mapping(nodes, links)
    mp.inputs["Scale"].default_value = (2.0, 2.0, 2.0)
    # Musgrave for vein pattern
    musgrave = nodes.new("ShaderNodeTexMusgrave")
    musgrave.inputs["Scale"].default_value = 5.0
    musgrave.inputs["Detail"].default_value = 8.0
    links.new(mp.outputs["Vector"], musgrave.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.4
    ramp.color_ramp.elements[0].color = (0.92, 0.90, 0.88, 1)
    ramp.color_ramp.elements[1].position = 0.6
    ramp.color_ramp.elements[1].color = (0.70, 0.68, 0.65, 1)
    links.new(musgrave.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.12
    bsdf.inputs["Specular"].default_value = 0.5
    return mat

def make_steel_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Steel")
    bsdf.inputs["Base Color"].default_value = (0.55, 0.56, 0.58, 1)
    bsdf.inputs["Metallic"].default_value = 0.95
    bsdf.inputs["Roughness"].default_value = 0.18
    bsdf.inputs["Specular"].default_value = 0.6
    return mat

def make_fabric_material(r=0.35, g=0.38, b=0.45):
    mat, nodes, links, bsdf = _new_pbr("PBR_Fabric")
    mp = _add_texcoord_mapping(nodes, links)
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 60.0
    noise.inputs["Detail"].default_value = 4.0
    links.new(mp.outputs["Vector"], noise.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.4
    ramp.color_ramp.elements[0].color = (r * 0.85, g * 0.85, b * 0.85, 1)
    ramp.color_ramp.elements[1].position = 0.6
    ramp.color_ramp.elements[1].color = (r, g, b, 1)
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Specular"].default_value = 0.1
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.25
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat

def make_leather_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Leather")
    mp = _add_texcoord_mapping(nodes, links)
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 30.0
    noise.inputs["Detail"].default_value = 8.0
    links.new(mp.outputs["Vector"], noise.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.4
    ramp.color_ramp.elements[0].color = (0.12, 0.08, 0.06, 1)
    ramp.color_ramp.elements[1].position = 0.6
    ramp.color_ramp.elements[1].color = (0.18, 0.12, 0.08, 1)
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.45
    bsdf.inputs["Specular"].default_value = 0.4
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.3
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat

def make_glass_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Glass")
    bsdf.inputs["Base Color"].default_value = (0.85, 0.92, 0.95, 1)
    bsdf.inputs["Transmission"].default_value = 0.95
    bsdf.inputs["IOR"].default_value = 1.45
    bsdf.inputs["Roughness"].default_value = 0.02
    bsdf.inputs["Alpha"].default_value = 0.3
    mat.blend_method = 'HASHED'
    return mat

def make_ceramic_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Ceramic")
    bsdf.inputs["Base Color"].default_value = (0.95, 0.95, 0.93, 1)
    bsdf.inputs["Roughness"].default_value = 0.15
    bsdf.inputs["Specular"].default_value = 0.5
    return mat

def make_tile_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Tile")
    mp = _add_texcoord_mapping(nodes, links)
    mp.inputs["Scale"].default_value = (4.0, 4.0, 4.0)
    checker = nodes.new("ShaderNodeTexChecker")
    checker.inputs["Scale"].default_value = 8.0
    checker.inputs["Color1"].default_value = (0.28, 0.25, 0.22, 1)
    checker.inputs["Color2"].default_value = (0.32, 0.29, 0.26, 1)
    links.new(mp.outputs["Vector"], checker.inputs["Vector"])
    links.new(checker.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.35
    bsdf.inputs["Specular"].default_value = 0.4
    return mat

def make_wall_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Wall")
    mp = _add_texcoord_mapping(nodes, links)
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 80.0
    noise.inputs["Detail"].default_value = 2.0
    links.new(mp.outputs["Vector"], noise.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.45
    ramp.color_ramp.elements[0].color = (0.88, 0.88, 0.86, 1)
    ramp.color_ramp.elements[1].position = 0.55
    ramp.color_ramp.elements[1].color = (0.92, 0.92, 0.90, 1)
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.05
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat

def make_painted_wood_material(r=0.85, g=0.85, b=0.82):
    """Painted cabinet body – flat color with very subtle grain."""
    mat, nodes, links, bsdf = _new_pbr("PBR_PaintedWood")
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1)
    bsdf.inputs["Roughness"].default_value = 0.6
    bsdf.inputs["Specular"].default_value = 0.25
    return mat

def make_terracotta_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Terracotta")
    bsdf.inputs["Base Color"].default_value = (0.72, 0.38, 0.22, 1)
    bsdf.inputs["Roughness"].default_value = 0.75
    bsdf.inputs["Specular"].default_value = 0.15
    return mat

def make_foliage_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Foliage")
    bsdf.inputs["Base Color"].default_value = (0.15, 0.45, 0.12, 1)
    bsdf.inputs["Roughness"].default_value = 0.7
    bsdf.inputs["Specular"].default_value = 0.15
    return mat

def make_dark_strip_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_DarkStrip")
    bsdf.inputs["Base Color"].default_value = (0.08, 0.08, 0.08, 1)
    bsdf.inputs["Roughness"].default_value = 0.5
    return mat

def make_emissive_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Emissive")
    bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1)
    bsdf.inputs["Emission"].default_value = (1.0, 0.95, 0.9, 1)
    return mat

def make_generic_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Generic")
    bsdf.inputs["Base Color"].default_value = (0.65, 0.65, 0.65, 1)
    bsdf.inputs["Roughness"].default_value = 0.7
    return mat

def make_soil_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Soil")
    bsdf.inputs["Base Color"].default_value = (0.22, 0.15, 0.08, 1)
    bsdf.inputs["Roughness"].default_value = 0.95
    return mat

def make_stone_material():
    mat, nodes, links, bsdf = _new_pbr("PBR_Stone")
    mp = _add_texcoord_mapping(nodes, links)
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 6.0
    noise.inputs["Detail"].default_value = 8.0
    links.new(mp.outputs["Vector"], noise.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[0].color = (0.5, 0.48, 0.45, 1)
    ramp.color_ramp.elements[1].position = 0.7
    ramp.color_ramp.elements[1].color = (0.65, 0.62, 0.58, 1)
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.65
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.2
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat

# Create all materials once
mat_wood       = make_wood_material()
mat_marble     = make_marble_material()
mat_steel      = make_steel_material()
mat_fabric     = make_fabric_material()
mat_leather    = make_leather_material()
mat_glass      = make_glass_material()
mat_ceramic    = make_ceramic_material()
mat_tile       = make_tile_material()
mat_wall       = make_wall_material()
mat_painted    = make_painted_wood_material()
mat_terracotta = make_terracotta_material()
mat_foliage    = make_foliage_material()
mat_dark_strip = make_dark_strip_material()
mat_emissive   = make_emissive_material()
mat_generic    = make_generic_material()
mat_soil       = make_soil_material()
mat_stone      = make_stone_material()

# ─── Coordinate system ────────────────────────────────────────────────────────
# Plan: X=right, Y=down (0 at top), origin top-left
# Blender: X=right, Y=forward (into screen), Z=up
# Mapping: plan_x → blend_x, plan_y → blend_y, height → blend_z
# So the floor is the XY plane, walls grow along Z.

def p2b(plan_x, plan_y):
    """Convert plan cm coords to Blender metres (X,Y)."""
    return plan_x * SCALE, plan_y * SCALE

def add_polygon_extrusion(vertices_2d, height, location, rotation, name, mat):
    """Create a 3D extruded prism mesh from a list of 2D vertices."""
    import bpy
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    
    n = len(vertices_2d)
    verts = []
    for x, y in vertices_2d:
        verts.append((x, y, 0))
    for x, y in vertices_2d:
        verts.append((x, y, height))
        
    faces = []
    faces.append(list(range(n - 1, -1, -1)))
    faces.append(list(range(n, 2 * n)))
    for i in range(n):
        next_i = (i + 1) % n
        faces.append([i, next_i, next_i + n, i + n])
        
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    
    # Set location (supports 2D or 3D location)
    if isinstance(location, (list, tuple)) and len(location) == 3:
        obj.location = (location[0], location[1], location[2])
    else:
        obj.location = (location[0], location[1], 0)

    # Set rotation_euler (supports Z-angle or 3D rotation)
    if isinstance(rotation, (int, float)):
        obj.rotation_euler = (0, 0, rotation)
    elif isinstance(rotation, (list, tuple)) and len(rotation) == 3:
        obj.rotation_euler = (rotation[0], rotation[1], rotation[2])
    else:
        obj.rotation_euler = (0, 0, 0)
    apply_mat(obj, mat)
    return obj

# ─── Furniture Helpers ───────────────────────────────────────────────────────
def _link(obj):
    """Link object to main collection."""
    bpy.context.collection.objects.link(obj)
    return obj

def _cube(name, sx, sy, sz, lx, ly, lz, mat):
    """Create a box centred at (lx, ly, lz) with full dimensions sx, sy, sz."""
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    # Use primitive_cube_add, then adjust
    bpy.ops.mesh.primitive_cube_add(size=1, location=(lx, ly, lz))
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = (sx, sy, sz)
    apply_mat(ob, mat)
    return ob

def _cyl(name, *args, **kwargs):
    """Create a cylinder or cone. Supports both standard and tapered/cone signatures dynamically."""
    import bpy
    radius_top = 0.05
    radius_bottom = 0.05
    depth = 0.1
    lx, ly, lz = 0.0, 0.0, 0.0
    mat_arg = None
    verts = kwargs.get("verts", 24)

    # Separate numeric arguments from non-numeric arguments (material)
    remaining_args = list(args)
    if "mat" in kwargs:
        mat_arg = kwargs["mat"]
    else:
        for i in range(len(remaining_args) - 1, -1, -1):
            val = remaining_args[i]
            # Materials are not floats or ints
            if not isinstance(val, (int, float)):
                mat_arg = val
                if i < len(remaining_args) - 1:
                    verts = remaining_args[i+1]
                remaining_args = remaining_args[:i]
                break

    # Parse numeric coordinates
    if len(remaining_args) == 5:
        # Standard: radius, depth, lx, ly, lz
        radius_top = radius_bottom = remaining_args[0]
        depth = remaining_args[1]
        lx, ly, lz = remaining_args[2], remaining_args[3], remaining_args[4]
    elif len(remaining_args) == 6:
        # Tapered/Cone: radius_bottom, radius_top, depth, lx, ly, lz
        radius_bottom = remaining_args[0]
        radius_top = remaining_args[1]
        depth = remaining_args[2]
        lx, ly, lz = remaining_args[3], remaining_args[4], remaining_args[5]
    elif len(remaining_args) == 4:
        # radius, depth, lx, ly
        radius_top = radius_bottom = remaining_args[0]
        depth = remaining_args[1]
        lx, ly = remaining_args[2], remaining_args[3]
        lz = 0.0
    elif len(remaining_args) >= 1:
        radius_top = radius_bottom = remaining_args[0]
        if len(remaining_args) > 1: depth = remaining_args[1]
        if len(remaining_args) > 2: lx = remaining_args[2]
        if len(remaining_args) > 3: ly = remaining_args[3]
        if len(remaining_args) > 4: lz = remaining_args[4]

    try:
        verts_int = int(verts)
    except:
        verts_int = 24

    avg_radius = (radius_bottom + radius_top) / 2.0
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=verts_int, 
        radius=avg_radius, 
        depth=depth,
        location=(lx, ly, lz)
    )
    ob = bpy.context.active_object
    ob.name = name
    if mat_arg:
        apply_mat(ob, mat_arg)
    return ob

def _parent_empty(name, ox, oy, rot):
    """Create an empty to serve as parent for grouped furniture pieces."""
    bpy.ops.object.empty_add(type='PLAIN_AXES', location=(ox, oy, 0))
    empty = bpy.context.active_object
    empty.name = name
    empty.rotation_euler = (0, 0, rot)
    empty.empty_display_size = 0.1
    return empty

def _set_parent(child, parent):
    """Parent child to parent, keeping child transform relative."""
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()

def build_from_primitives(ox, oy, rot, idx, otype, primitives):
    """Draw a custom object from simplified 3D shapes (primitives) data."""
    parent = _parent_empty(f"Obj_Custom_{otype}_{idx}", ox, oy, rot)
    
    mat_map = {
        "wood": mat_wood,
        "steel": mat_steel,
        "metal": mat_steel,
        "marble": mat_marble,
        "glass": mat_glass,
        "ceramic": mat_ceramic,
        "painted": mat_painted,
        "foliage": mat_foliage,
        "stone": mat_stone,
        "leather": mat_leather,
        "fabric": mat_fabric,
        "generic": mat_generic
    }
    
    for i, prim in enumerate(primitives):
        shape = prim.get("shape", "cube").lower()
        size = prim.get("size", [0.2, 0.2, 0.2])
        pos = prim.get("pos", [0, 0, 0])
        p_rot = prim.get("rot", [0, 0, 0])
        mat_name = prim.get("mat", "generic").lower()
        mat = mat_map.get(mat_name, mat_generic)
        
        name = f"Prim_{shape}_{idx}_{i}"
        
        try:
            if shape == "cube" or shape == "box":
                ob = _cube(name, size[0], size[1], size[2], 0, 0, 0, mat)
            elif shape == "cylinder":
                ob = _cyl(name, size[0], size[1], 0, 0, 0, mat)
            elif shape == "sphere":
                bpy.ops.mesh.primitive_uv_sphere_add(radius=size[0], location=(0, 0, 0))
                ob = bpy.context.active_object
                ob.name = name
                apply_mat(ob, mat)
            else:
                ob = _cube(name, size[0], size[1], size[2], 0, 0, 0, mat)
                
            _set_parent(ob, parent)
            ob.location = (pos[0], pos[1], pos[2])
            ob.rotation_euler = (math.radians(p_rot[0]), math.radians(p_rot[1]), math.radians(p_rot[2]))
        except Exception as e:
            print(f"[blender_scene] Warning: could not draw primitive {i} for {otype}: {e}")
            
    return parent

# ─── Furniture Builders ──────────────────────────────────────────────────────
# Each returns the parent empty so flipH/flipV can be applied to it.

def build_dining_table(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Table_{idx}", ox, oy, rot)
    # Tabletop: 4cm thick, at 0.76m
    top = _cube(f"TableTop_{idx}", ow, od, 0.04, ox, oy, 0.76, mat_wood)
    _set_parent(top, parent)
    # 4 legs: cylindrical, radius 2cm
    leg_r = 0.02
    inx, iny = ow / 2 - 0.05, od / 2 - 0.05
    for i, (sx, sy) in enumerate([(-1, -1), (1, -1), (1, 1), (-1, 1)]):
        leg = _cyl(f"TableLeg_{idx}_{i}", leg_r, 0.74, ox + sx * inx, oy + sy * iny, 0.37, mat_wood)
        _set_parent(leg, parent)
    return parent

def build_chair(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Chair_{idx}", ox, oy, rot)
    # Seat cushion at 0.45m, 4cm thick
    seat = _cube(f"ChairSeat_{idx}", ow, od, 0.04, ox, oy, 0.45, mat_fabric)
    _set_parent(seat, parent)
    # 4 legs
    leg_r = 0.015
    inx, iny = ow / 2 - 0.03, od / 2 - 0.03
    for i, (sx, sy) in enumerate([(-1, -1), (1, -1), (1, 1), (-1, 1)]):
        leg = _cyl(f"ChairLeg_{idx}_{i}", leg_r, 0.45, ox + sx * inx, oy + sy * iny, 0.225, mat_steel)
        _set_parent(leg, parent)
    # Backrest: thin slab at back (+Y side), from 0.45 to 0.85m
    back = _cube(f"ChairBack_{idx}", ow, 0.03, 0.40, ox, oy + od / 2 - 0.015, 0.65, mat_wood)
    _set_parent(back, parent)
    return parent

def build_bar_stool(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"BarStool_{idx}", ox, oy, rot)
    seat_r = min(ow, od) / 2
    # Seat at 0.75m
    seat = _cyl(f"StoolSeat_{idx}", seat_r, 0.04, ox, oy, 0.75, mat_leather)
    _set_parent(seat, parent)
    # Pedestal leg
    leg = _cyl(f"StoolLeg_{idx}", 0.025, 0.73, ox, oy, 0.365, mat_steel)
    _set_parent(leg, parent)
    # Base plate
    base = _cyl(f"StoolBase_{idx}", seat_r * 0.7, 0.02, ox, oy, 0.01, mat_steel)
    _set_parent(base, parent)
    # Footrest ring at 0.25m (use a thin torus-like cylinder ring)
    ring = _cyl(f"StoolRing_{idx}", seat_r * 0.55, 0.02, ox, oy, 0.25, mat_steel)
    _set_parent(ring, parent)
    return parent

def build_sofa(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Sofa_{idx}", ox, oy, rot)
    base_h = 0.12
    seat_h = 0.18
    back_h = 0.35
    arm_h = 0.25
    arm_w = 0.10
    # Base frame
    base = _cube(f"SofaBase_{idx}", ow, od, base_h, ox, oy, base_h / 2, mat_wood)
    _set_parent(base, parent)
    # Seat cushion
    seat_w = ow - 2 * arm_w
    seat = _cube(f"SofaSeat_{idx}", seat_w, od - 0.08, seat_h,
                 ox, oy - 0.04, base_h + seat_h / 2, mat_fabric)
    _set_parent(seat, parent)
    # Back cushion (angled slightly via scale, simplified as upright box)
    bk = _cube(f"SofaBack_{idx}", seat_w, 0.12, back_h,
               ox, oy + od / 2 - 0.06, base_h + seat_h + back_h / 2, mat_fabric)
    _set_parent(bk, parent)
    # Left armrest
    la = _cube(f"SofaArmL_{idx}", arm_w, od, arm_h,
               ox - ow / 2 + arm_w / 2, oy, base_h + arm_h / 2, mat_fabric)
    _set_parent(la, parent)
    # Right armrest
    ra = _cube(f"SofaArmR_{idx}", arm_w, od, arm_h,
               ox + ow / 2 - arm_w / 2, oy, base_h + arm_h / 2, mat_fabric)
    _set_parent(ra, parent)
    return parent

def build_counter(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Counter_{idx}", ox, oy, rot)
    cab_h = 0.86
    top_thick = 0.03
    # Cabinet body
    cab = _cube(f"CounterCab_{idx}", ow, od, cab_h, ox, oy, cab_h / 2, mat_painted)
    _set_parent(cab, parent)
    # Countertop with overhang
    top = _cube(f"CounterTop_{idx}", ow + 0.02, od + 0.02, top_thick,
                ox, oy, cab_h + top_thick / 2, mat_marble)
    _set_parent(top, parent)
    # Door lines (thin dark strips on front face)
    num_doors = max(1, int(ow / 0.5))
    door_w = ow / num_doors
    for d in range(num_doors - 1):
        strip_x = ox - ow / 2 + door_w * (d + 1)
        strip = _cube(f"CounterStrip_{idx}_{d}", 0.005, od + 0.002, cab_h * 0.85,
                       strip_x, oy, cab_h * 0.45, mat_dark_strip)
        _set_parent(strip, parent)
    return parent

def build_bar(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Bar_{idx}", ox, oy, rot)
    bar_h = 1.10
    top_thick = 0.04
    # Body
    body = _cube(f"BarBody_{idx}", ow, od, bar_h, ox, oy, bar_h / 2, mat_painted)
    _set_parent(body, parent)
    # Top overhang
    top = _cube(f"BarTop_{idx}", ow + 0.06, od + 0.04, top_thick,
                ox, oy, bar_h + top_thick / 2, mat_marble)
    _set_parent(top, parent)
    return parent

def build_sink(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Sink_{idx}", ox, oy, rot)
    cab_h = 0.86
    top_thick = 0.03
    # Counter base
    cab = _cube(f"SinkCab_{idx}", ow, od, cab_h, ox, oy, cab_h / 2, mat_painted)
    _set_parent(cab, parent)
    # Countertop
    top = _cube(f"SinkTop_{idx}", ow + 0.02, od + 0.02, top_thick,
                ox, oy, cab_h + top_thick / 2, mat_marble)
    _set_parent(top, parent)
    # Basin inset (darker rectangle)
    basin_w = min(ow * 0.6, 0.50)
    basin_d = min(od * 0.5, 0.35)
    basin = _cube(f"SinkBasin_{idx}", basin_w, basin_d, 0.01,
                  ox, oy, cab_h + top_thick + 0.005, mat_ceramic)
    _set_parent(basin, parent)
    # Faucet: vertical cylinder + small horizontal
    faucet_base = _cyl(f"SinkFaucetBase_{idx}", 0.012, 0.20,
                       ox, oy + basin_d / 2 + 0.04, cab_h + top_thick + 0.10, mat_steel)
    _set_parent(faucet_base, parent)
    faucet_arm = _cyl(f"SinkFaucetArm_{idx}", 0.008, 0.08,
                      ox, oy + basin_d / 2 + 0.04, cab_h + top_thick + 0.20, mat_steel)
    faucet_arm.rotation_euler = (math.pi / 2, 0, 0)
    _set_parent(faucet_arm, parent)
    return parent

def build_stove(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Stove_{idx}", ox, oy, rot)
    body_h = 0.86
    # Appliance body
    body = _cube(f"StoveBody_{idx}", ow, od, body_h, ox, oy, body_h / 2, mat_steel)
    _set_parent(body, parent)
    # Top surface (slightly raised)
    top = _cube(f"StoveTop_{idx}", ow, od, 0.02, ox, oy, body_h + 0.01, mat_steel)
    _set_parent(top, parent)
    # 4 burner rings (2x2 grid)
    burner_r = min(ow, od) * 0.12
    offsets = [(-0.25, -0.25), (0.25, -0.25), (-0.25, 0.25), (0.25, 0.25)]
    for i, (fx, fy) in enumerate(offsets):
        bx = ox + ow * fx
        by = oy + od * fy
        ring = _cyl(f"Burner_{idx}_{i}", burner_r, 0.008,
                    bx, by, body_h + 0.024, mat_dark_strip, verts=32)
        _set_parent(ring, parent)
    # Oven door: inset rectangle on front face
    door_h = body_h * 0.55
    door = _cube(f"OvenDoor_{idx}", ow * 0.85, 0.005, door_h,
                 ox, oy - od / 2 + 0.003, body_h * 0.35, mat_dark_strip)
    _set_parent(door, parent)
    # Handle bar
    handle = _cyl(f"OvenHandle_{idx}", 0.008, ow * 0.5,
                  ox, oy - od / 2 - 0.01, body_h * 0.65, mat_steel)
    handle.rotation_euler = (0, math.pi / 2, 0)
    _set_parent(handle, parent)
    return parent

def build_refrigerator(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Fridge_{idx}", ox, oy, rot)
    body_h = 1.80
    # Main body
    body = _cube(f"FridgeBody_{idx}", ow, od, body_h, ox, oy, body_h / 2, mat_steel)
    _set_parent(body, parent)
    # Door line (horizontal split at 0.6 * height)
    split_z = body_h * 0.6
    line = _cube(f"FridgeLine_{idx}", ow * 0.95, 0.005, 0.005,
                 ox, oy - od / 2 + 0.003, split_z, mat_dark_strip)
    _set_parent(line, parent)
    # Handle (vertical cylinder on front)
    handle = _cyl(f"FridgeHandle_{idx}", 0.01, 0.25,
                  ox + ow * 0.4, oy - od / 2 - 0.015, body_h * 0.45, mat_steel)
    _set_parent(handle, parent)
    # Upper handle
    handle2 = _cyl(f"FridgeHandle2_{idx}", 0.01, 0.18,
                   ox + ow * 0.4, oy - od / 2 - 0.015, body_h * 0.78, mat_steel)
    _set_parent(handle2, parent)
    return parent

def build_display_case(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Display_{idx}", ox, oy, rot)
    case_h = 1.40
    frame_t = 0.025
    # 4 vertical frame edges
    for i, (sx, sy) in enumerate([(-1, -1), (1, -1), (1, 1), (-1, 1)]):
        fx = ox + sx * (ow / 2 - frame_t / 2)
        fy = oy + sy * (od / 2 - frame_t / 2)
        edge = _cube(f"DispFrame_{idx}_{i}", frame_t, frame_t, case_h,
                     fx, fy, case_h / 2, mat_steel)
        _set_parent(edge, parent)
    # Glass panels (front and sides)
    # Front
    glass_f = _cube(f"DispGlassF_{idx}", ow - 2 * frame_t, 0.005, case_h - 0.1,
                    ox, oy - od / 2 + 0.003, case_h / 2, mat_glass)
    _set_parent(glass_f, parent)
    # Left
    glass_l = _cube(f"DispGlassL_{idx}", 0.005, od - 2 * frame_t, case_h - 0.1,
                    ox - ow / 2 + 0.003, oy, case_h / 2, mat_glass)
    _set_parent(glass_l, parent)
    # Right
    glass_r = _cube(f"DispGlassR_{idx}", 0.005, od - 2 * frame_t, case_h - 0.1,
                    ox + ow / 2 - 0.003, oy, case_h / 2, mat_glass)
    _set_parent(glass_r, parent)
    # Internal shelves (2)
    for s in range(2):
        sz = case_h * (s + 1) / 3
        shelf = _cube(f"DispShelf_{idx}_{s}", ow - 2 * frame_t, od - 0.02, 0.01,
                      ox, oy, sz, mat_glass)
        _set_parent(shelf, parent)
    # LED strip at top
    led = _cube(f"DispLED_{idx}", ow - 2 * frame_t, 0.01, 0.01,
                ox, oy, case_h - 0.02, mat_emissive)
    _set_parent(led, parent)
    return parent

def build_shelves(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Shelves_{idx}", ox, oy, rot)
    shelf_h = 1.50
    panel_t = 0.02
    num_shelves = 4
    # Two vertical side panels
    for sx in (-1, 1):
        panel = _cube(f"ShelfSide_{idx}_{sx}", panel_t, od, shelf_h,
                      ox + sx * (ow / 2 - panel_t / 2), oy, shelf_h / 2, mat_wood)
        _set_parent(panel, parent)
    # Horizontal shelf boards
    for s in range(num_shelves):
        sz = shelf_h * s / (num_shelves - 1) if num_shelves > 1 else 0
        board = _cube(f"ShelfBoard_{idx}_{s}", ow - 2 * panel_t, od, panel_t,
                      ox, oy, sz + panel_t / 2, mat_wood)
        _set_parent(board, parent)
    return parent

def build_staircase(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Stairs_{idx}", ox, oy, rot)
    steps = max(8, int(wh / 0.18))
    step_d = od / steps
    step_h = wh / steps
    overhang = 0.02
    for s in range(steps):
        local_y = -od / 2 + step_d * (s + 0.5)
        local_z_tread = step_h * (s + 1)
        local_z_riser = step_h * (s + 0.5)
        
        # Tread
        tread = _cube(f"StairTread_{idx}_{s}", ow, step_d + overhang, 0.03, 0, 0, 0, mat_stone)
        _set_parent(tread, parent)
        tread.location = (0, local_y, local_z_tread - 0.015)
        
        # Riser
        riser = _cube(f"StairRiser_{idx}_{s}", ow, 0.02, step_h, 0, 0, 0, mat_stone)
        _set_parent(riser, parent)
        riser.location = (0, local_y - step_d/2, local_z_riser)
        
    return parent

def build_plant(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Plant_{idx}", ox, oy, rot)
    pot_r = min(ow, od) * 0.3
    pot_h = 0.25
    # Tapered pot (cone)
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=pot_r, radius2=pot_r * 0.7,
                                    depth=pot_h, location=(ox, oy, pot_h / 2))
    pot = bpy.context.active_object
    pot.name = f"Pot_{idx}"
    apply_mat(pot, mat_terracotta)
    _set_parent(pot, parent)
    # Soil disc
    soil = _cyl(f"Soil_{idx}", pot_r * 0.68, 0.015, ox, oy, pot_h - 0.01, mat_soil)
    _set_parent(soil, parent)
    # Foliage (icosphere)
    foliage_r = min(ow, od) * 0.5
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=foliage_r,
                                          location=(ox, oy, pot_h + foliage_r * 0.8))
    foliage = bpy.context.active_object
    foliage.name = f"Foliage_{idx}"
    apply_mat(foliage, mat_foliage)
    _set_parent(foliage, parent)
    return parent

def build_door(ox, oy, ow, od, rot, idx):
    parent = _parent_empty(f"Door_{idx}", ox, oy, rot)
    h = 2.0  # door height in meters
    frame_t = 0.04 # frame thickness
    
    # Left frame post
    left = _cube(f"DoorFrameL_{idx}", frame_t, od + 0.01, h, 0, 0, 0, mat_wood)
    _set_parent(left, parent)
    left.location = (-ow/2 + frame_t/2, 0, h/2)
    
    # Right frame post
    right = _cube(f"DoorFrameR_{idx}", frame_t, od + 0.01, h, 0, 0, 0, mat_wood)
    _set_parent(right, parent)
    right.location = (ow/2 - frame_t/2, 0, h/2)
    
    # Top frame piece
    top = _cube(f"DoorFrameT_{idx}", ow, od + 0.01, frame_t, 0, 0, 0, mat_wood)
    _set_parent(top, parent)
    top.location = (0, 0, h - frame_t/2)
    
    # Door panel (closed)
    panel_w = ow - frame_t * 2
    panel_t = 0.03
    panel_h = h - frame_t
    panel = _cube(f"DoorPanel_{idx}", panel_w, panel_t, panel_h, 0, 0, 0, mat_painted)
    _set_parent(panel, parent)
    panel.location = (0, 0, panel_h/2)
    
    return parent

def build_window(ox, oy, ow, od, rot, idx):
    # Window raised 0.9m off floor
    parent = _parent_empty(f"Window_{idx}", ox, oy, rot)
    parent.location.z = 0.9
    
    h = 1.10  # window height in meters
    frame_t = 0.04
    
    # Left frame
    left = _cube(f"WinFrameL_{idx}", frame_t, od + 0.01, h, 0, 0, 0, mat_steel)
    _set_parent(left, parent)
    left.location = (-ow/2 + frame_t/2, 0, h/2)
    
    # Right frame
    right = _cube(f"WinFrameR_{idx}", frame_t, od + 0.01, h, 0, 0, 0, mat_steel)
    _set_parent(right, parent)
    right.location = (ow/2 - frame_t/2, 0, h/2)
    
    # Top frame
    top = _cube(f"WinFrameT_{idx}", ow, od + 0.01, frame_t, 0, 0, 0, mat_steel)
    _set_parent(top, parent)
    top.location = (0, 0, h - frame_t/2)
    
    # Bottom frame
    bottom = _cube(f"WinFrameB_{idx}", ow, od + 0.01, frame_t, 0, 0, 0, mat_steel)
    _set_parent(bottom, parent)
    bottom.location = (0, 0, frame_t/2)
    
    # Glass pane
    glass_w = ow - frame_t * 2
    glass_h = h - frame_t * 2
    glass = _cube(f"WinGlass_{idx}", glass_w, 0.01, glass_h, 0, 0, 0, mat_glass)
    _set_parent(glass, parent)
    glass.location = (0, 0, h/2)
    
    return parent

def build_generic(ox, oy, ow, od, rot, idx, otype="generic"):
    parent = _parent_empty(f"Obj_{otype}_{idx}", ox, oy, rot)
    h = 0.90
    body = _cube(f"ObjBody_{otype}_{idx}", ow, od, h, ox, oy, h / 2, mat_generic)
    _set_parent(body, parent)
    return parent

# ─── Builder dispatch table ──────────────────────────────────────────────────
BUILDERS = {
    "dining_table": build_dining_table,
    "table":        build_dining_table,
    "chair":        build_chair,
    "bar_stool":    build_bar_stool,
    "sofa":         build_sofa,
    "counter":      build_counter,
    "kitchen_counter": build_counter,
    "bar":          build_bar,
    "sink":         build_sink,
    "stove":        build_stove,
    "oven":         build_stove,
    "refrigerator": build_refrigerator,
    "display_case": build_display_case,
    "shelves":      build_shelves,
    "staircase":    build_staircase,
    "stairs":       build_staircase,
    "plant":        build_plant,
    "door":         build_door,
    "window":       build_window,
}

# ─── Floor ───────────────────────────────────────────────────────────────────
cx, cy = fw / 2, fh / 2
bpy.ops.mesh.primitive_plane_add(size=1, location=(cx, cy, 0))
floor_obj = bpy.context.active_object
floor_obj.name = "Floor"
floor_obj.scale = (fw, fh, 1)
apply_mat(floor_obj, mat_tile)

# ─── Camera Setup (pre-parsed for wall clipping checks) ─────────────────────
is_3d   = camera_data.get("is3d", False)
bx_cam, by_cam = fw / 2, fh / 3
cdx_cam, cdy_cam = 0.0, 1.0

if is_3d and "px" in camera_data and "py" in camera_data and "pz" in camera_data:
    cx_f = floor_w / 2
    cy_f = floor_h / 2
    bx_cam = (camera_data["px"] + cx_f) * SCALE
    by_cam = (camera_data["pz"] + cy_f) * SCALE
    cdx_cam = camera_data.get("dx", 0.0)
    cdy_cam = camera_data.get("dz", 1.0)
else:
    cam_px  = camera_data.get("x", floor_w / 2)
    cam_py  = camera_data.get("y", floor_h / 3)
    bx_cam, by_cam = p2b(cam_px, cam_py)
    
    cam_ang = camera_data.get("angle", 0)   # degrees, 0 = looking toward +Y
    yaw_rad = math.radians(cam_ang)
    cdx_cam = -math.sin(yaw_rad)
    cdy_cam = math.cos(yaw_rad)

# Normalize direction
dir_len = math.hypot(cdx_cam, cdy_cam)
if dir_len > 0.001:
    cdx_cam /= dir_len
    cdy_cam /= dir_len
else:
    cdx_cam, cdy_cam = 0.0, 1.0

# ─── Walls ───────────────────────────────────────────────────────────────────
for i, wall in enumerate(walls):
    c1 = corners.get(wall.get("corner1"))
    c2 = corners.get(wall.get("corner2"))
    if not c1 or not c2:
        continue
    x1, y1 = p2b(c1["x"], c1["y"])
    x2, y2 = p2b(c2["x"], c2["y"])
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    if length < 0.001:
        continue
    
    # Project camera onto the wall segment to check distance (clipping)
    vx, vy = dx, dy
    wall_len_sq = vx*vx + vy*vy
    if wall_len_sq > 0.0001:
        wx, wy = bx_cam - x1, by_cam - y1
        t_cam = (wx*vx + wy*vy) / wall_len_sq
        t_cam_clamped = max(0.0, min(1.0, t_cam))
        proj_x = x1 + t_cam_clamped * vx
        proj_y = y1 + t_cam_clamped * vy
        cam_dist = math.hypot(bx_cam - proj_x, by_cam - proj_y)
        
        # Check if wall is behind camera
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        to_wall_x, to_wall_y = mx - bx_cam, my - by_cam
        to_wall_len = math.hypot(to_wall_x, to_wall_y)
        if to_wall_len > 0.001:
            to_wall_x /= to_wall_len
            to_wall_y /= to_wall_len
            dot_prod = to_wall_x * cdx_cam + to_wall_y * cdy_cam
        else:
            dot_prod = 0.0
            
        # Hide wall if camera is extremely close (< 0.8m) or if wall center is behind camera
        if cam_dist < 0.8 or dot_prod < -0.1:
            print(f"[blender_scene] Hiding wall {i} to prevent camera clipping (dist={cam_dist:.2f}m, dot={dot_prod:.2f})")
            continue

    angle = math.atan2(dy, dx)   # rotation around Z axis
    
    # Find openings (doors/windows) on this wall segment
    openings = []
    for obj in objects:
        otype = obj.get("type", "generic").lower()
        if otype != "door" and otype != "window":
            continue
            
        ox_val, oy_val = p2b(obj.get("x", 0), obj.get("y", 0))
        
        # Project object position onto the wall line segment
        vx, vy = dx, dy
        wall_len_sq = vx*vx + vy*vy
        if wall_len_sq < 0.0001:
            continue
            
        wx, wy = ox_val - x1, oy_val - y1
        t = (wx*vx + wy*vy) / wall_len_sq
        
        if 0.0 <= t <= 1.0:
            proj_x = x1 + t * vx
            proj_y = y1 + t * vy
            dist = math.hypot(ox_val - proj_x, oy_val - proj_y)
            if dist < (wt / 2 + 0.25): # within wall thickness + 25cm
                op_w = max(obj.get("w", 80), 30) * SCALE
                op_center_dist = t * length
                openings.append({
                    "type": otype,
                    "start": max(0.0, op_center_dist - op_w / 2),
                    "end": min(length, op_center_dist + op_w / 2)
                })

    # Sort and merge openings
    openings.sort(key=lambda o: o["start"])
    merged_openings = []
    for op in openings:
        if not merged_openings:
            merged_openings.append(op)
        else:
            last = merged_openings[-1]
            if op["start"] <= last["end"]:
                last["end"] = max(last["end"], op["end"])
            else:
                merged_openings.append(op)
                
    # Draw solid wall segments and window fills
    current_dist = 0.0
    for idx_op, op in enumerate(merged_openings):
        seg_len = op["start"] - current_dist
        if seg_len > 0.01:
            seg_center_dist = current_dist + seg_len / 2
            smx = x1 + (seg_center_dist / length) * dx
            smy = y1 + (seg_center_dist / length) * dy
            
            bpy.ops.mesh.primitive_cube_add(size=1, location=(smx, smy, wh / 2))
            w = bpy.context.active_object
            w.name = f"Wall_{i}_Seg_{idx_op}"
            w.scale = (seg_len, wt, wh)
            w.rotation_euler = (0, 0, angle)
            apply_mat(w, mat_wall)
            
        if op["type"] == "window":
            op_len = op["end"] - op["start"]
            op_center_dist = op["start"] + op_len / 2
            omx = x1 + (op_center_dist / length) * dx
            omy = y1 + (op_center_dist / length) * dy
            
            # Lower wall block (sill)
            sill_h = 0.9
            bpy.ops.mesh.primitive_cube_add(size=1, location=(omx, omy, sill_h / 2))
            w_low = bpy.context.active_object
            w_low.name = f"Wall_{i}_WinLow_{idx_op}"
            w_low.scale = (op_len, wt, sill_h)
            w_low.rotation_euler = (0, 0, angle)
            apply_mat(w_low, mat_wall)
            
            # Upper wall block (header)
            head_h = 2.0
            if wh > head_h:
                top_h = wh - head_h
                bpy.ops.mesh.primitive_cube_add(size=1, location=(omx, omy, head_h + top_h / 2))
                w_top = bpy.context.active_object
                w_top.name = f"Wall_{i}_WinTop_{idx_op}"
                w_top.scale = (op_len, wt, top_h)
                w_top.rotation_euler = (0, 0, angle)
                apply_mat(w_top, mat_wall)
                
        current_dist = op["end"]
        
    # Draw final segment
    seg_len = length - current_dist
    if seg_len > 0.01:
        seg_center_dist = current_dist + seg_len / 2
        smx = x1 + (seg_center_dist / length) * dx
        smy = y1 + (seg_center_dist / length) * dy
        
        bpy.ops.mesh.primitive_cube_add(size=1, location=(smx, smy, wh / 2))
        w = bpy.context.active_object
        w.name = f"Wall_{i}_End"
        w.scale = (seg_len, wt, wh)
        w.rotation_euler = (0, 0, angle)
        apply_mat(w, mat_wall)

# ─── World Lighting ──────────────────────────────────────────────────────────
world = bpy.data.worlds.new("Sky")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs["Color"].default_value    = (0.78, 0.82, 0.92, 1)
    bg.inputs["Strength"].default_value = 0.8

# Sun lamp – warm key light with shadows
bpy.ops.object.light_add(type='SUN', location=(cx, -2, wh * 2))
sun = bpy.context.active_object; sun.name = "Sun"
sun.data.energy = 3.5
sun.rotation_euler = (math.radians(55), 0, math.radians(-30))
sun.data.shadow_soft_size = 0.04

# Warm interior fill light (area)
bpy.ops.object.light_add(type='AREA', location=(cx * 0.5, cy * 0.5, wh * 0.85))
fill = bpy.context.active_object; fill.name = "FillWarm"
fill.data.energy = 600
fill.data.size = 5.0
fill.data.color = (1.0, 0.92, 0.82)
fill.rotation_euler = (math.radians(90), 0, 0)

# Secondary fill from opposite side
bpy.ops.object.light_add(type='AREA', location=(cx * 1.5, cy * 1.2, wh * 0.7))
fill2 = bpy.context.active_object; fill2.name = "FillCool"
fill2.data.energy = 300
fill2.data.size = 3.0
fill2.data.color = (0.85, 0.90, 1.0)
fill2.rotation_euler = (math.radians(70), 0, math.radians(180))

# ─── Camera ──────────────────────────────────────────────────────────────────
is_3d   = camera_data.get("is3d", False)
fov_v   = math.radians(camera_data.get("fov", 60))
aspect  = camera_data.get("aspect", 1280 / 720)

# Three.js FOV is vertical. Convert it to horizontal FOV for Blender's horizontal fitting
fov_h   = 2 * math.atan(math.tan(fov_v / 2) * aspect)

if is_3d and "px" in camera_data and "py" in camera_data and "pz" in camera_data:
    import mathutils
    cx = floor_w / 2
    cy = floor_h / 2
    bx = (camera_data["px"] + cx) * SCALE
    by = (camera_data["pz"] + cy) * SCALE
    bz = camera_data["py"] * SCALE

    bpy.ops.object.camera_add(location=(bx, by, bz))
    cam = bpy.context.active_object
    cam.name = "Camera"
    cam.data.lens_unit = 'FOV'
    cam.data.sensor_fit = 'HORIZONTAL'
    cam.data.angle = fov_h

    bdx = camera_data.get("dx", 0.0)
    bdy = camera_data.get("dz", 1.0)
    bdz = camera_data.get("dy", 0.0)

    direction = mathutils.Vector((bdx, bdy, bdz))
    if direction.length < 0.0001:
        direction = mathutils.Vector((0.0, 1.0, 0.0))
    rot_quat = direction.to_track_quat('-Z', 'Y')
    cam.rotation_euler = rot_quat.to_euler()
else:
    cam_px  = camera_data.get("x", floor_w / 2)
    cam_py  = camera_data.get("y", floor_h / 3)
    cam_ang = camera_data.get("angle", 0)   # degrees, 0 = looking toward +Y
    bx, by = p2b(cam_px, cam_py)
    eye_h   = 1.60  # metres

    bpy.ops.object.camera_add(location=(bx, by, eye_h))
    cam = bpy.context.active_object
    cam.name = "Camera"
    cam.data.lens_unit = 'FOV'
    cam.data.sensor_fit = 'HORIZONTAL'
    cam.data.angle     = fov_h

    yaw_rad = math.radians(cam_ang)
    cam.rotation_euler = (math.pi / 2, 0, yaw_rad)

# Mirror the camera's X-axis to fix horizontal flip caused by handedness
# mismatch between the 2D floor plan (screen-space) and Blender's RH coords
cam.scale.x = -1
scene.camera = cam


# === LIBRARY END ===

# ─── Furniture ───────────────────────────────────────────────────────────────
for idx, obj in enumerate(objects):
    otype = obj.get("type", "generic").lower()
    ox, oy = p2b(obj.get("x", 0), obj.get("y", 0))
    ow = max(obj.get("w", 60), 10) * SCALE
    od = max(obj.get("h", 60), 10) * SCALE
    rot = math.radians(obj.get("rotation", 0))

    shape = obj.get("shape", "rectangle")
    points = obj.get("points", None)
    h = 0.75

    parent_obj = None
    try:
        if shape == "l-shape":
            t = (obj.get("legThickness", 40) or 40) * SCALE
            vertices_2d = [
                (-ow/2, -od/2),
                (ow/2, -od/2),
                (ow/2, -od/2 + t),
                (-ow/2 + t, -od/2 + t),
                (-ow/2 + t, od/2),
                (-ow/2, od/2)
            ]
            parent_obj = add_polygon_extrusion(vertices_2d, h, (ox, oy), rot, f"L_Shape_{idx}", mat_painted)
            
        elif shape == "polygon" and points and len(points) >= 3:
            cx_cm = obj.get("x", 0)
            cy_cm = obj.get("y", 0)
            vertices_2d = []
            for p in points:
                px = (p["x"] - cx_cm) * SCALE
                py = (p["y"] - cy_cm) * SCALE
                vertices_2d.append((px, py))
            parent_obj = add_polygon_extrusion(vertices_2d, h, (ox, oy), rot, f"Custom_Poly_{idx}", mat_painted)
            
        else:
            prims = obj.get("primitives", None)
            if prims:
                parent_obj = build_from_primitives(ox, oy, rot, idx, otype, prims)
            else:
                builder = BUILDERS.get(otype, None)
                if builder:
                    parent_obj = builder(ox, oy, ow, od, rot, idx)
                else:
                    parent_obj = build_generic(ox, oy, ow, od, rot, idx, otype)

        if parent_obj:
            if obj.get("flipH", False):
                parent_obj.scale.x *= -1
            if obj.get("flipV", False):
                parent_obj.scale.y *= -1

    except Exception as e:
        print(f"[blender_scene] Warning: could not place object {idx}: {e}")

# ─── Render ──────────────────────────────────────────────────────────────────
scene.render.engine                     = 'CYCLES'
scene.cycles.device                     = 'CPU'
scene.cycles.samples                    = 8
scene.cycles.use_denoising             = True
scene.render.tile_x                     = 256
scene.render.tile_y                     = 256
scene.render.resolution_x               = 1280
scene.render.resolution_y               = 720
scene.render.resolution_percentage      = 100
scene.render.image_settings.file_format = 'JPEG'
scene.render.image_settings.quality     = 85
scene.render.filepath                   = output_path

print(f"[blender_scene] Scene: {len(walls)} walls, {len(objects)} objects")
if is_3d:
    print(f"[blender_scene] Camera (3D) at ({bx:.2f}, {by:.2f}, {bz:.2f}) fov={math.degrees(fov_h):.1f}°")
else:
    print(f"[blender_scene] Camera (2D) at ({cam_px},{cam_py}) angle={cam_ang}°, eye_h={eye_h}m")
print(f"[blender_scene] Rendering → {output_path}")
bpy.ops.render.render(write_still=True)
print("[blender_scene] Color render done.")

# ─── GLB Scene Export (for interactive 3D browser viewing) ───────────────────
glb_output_path = output_path.replace('.jpg', '.glb')
try:
    bpy.ops.export_scene.gltf(
        filepath=glb_output_path,
        export_format='GLB',
        export_apply=True,
        export_colors=True
    )
    print(f"[blender_scene] GLB exported → {glb_output_path}")
except Exception as e:
    print(f"[blender_scene] GLB export failed (non-fatal): {e}")

# ─── Depth Pass Render ───────────────────────────────────────────────────────
depth_output_path = output_path.replace('.jpg', '_depth.png')
try:
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()

    rl = tree.nodes.new('CompositorNodeRLayers')
    normalize = tree.nodes.new('CompositorNodeNormalize')
    composite = tree.nodes.new('CompositorNodeComposite')

    tree.links.new(rl.outputs['Depth'], normalize.inputs[0])
    tree.links.new(normalize.outputs[0], composite.inputs[0])

    # Switch to simpler render for depth (fewer samples needed)
    scene.cycles.samples = 1
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'BW'
    scene.render.image_settings.color_depth = '16'
    scene.render.filepath = depth_output_path

    bpy.ops.render.render(write_still=True)
    print(f"[blender_scene] Depth map rendered → {depth_output_path}")
except Exception as e:
    print(f"[blender_scene] Depth map render failed (non-fatal): {e}")

print("[blender_scene] All passes done.")
