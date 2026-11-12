"""Write a small sample Rhino model for testing the Rhino input step.

A 7.0 x 4.5 x 3.0 m room drawn in MILLIMETRES (to test unit conversion),
with windows on the south, north and west walls.
Writes data/rhino/sample_flat.3dm
"""
import rhino3dm

import config

OUT = config.ROOT / "data" / "rhino" / "sample_flat.3dm"


def add_layer(model, name):
    layer = rhino3dm.Layer()
    layer.Name = name
    model.Layers.Add(layer)
    return len(model.Layers) - 1


def on_layer(index):
    attributes = rhino3dm.ObjectAttributes()
    attributes.LayerIndex = index
    return attributes


def rectangle(model, corners, layer):
    """A flat four-sided surface (as a mesh) from four corner points."""
    mesh = rhino3dm.Mesh()
    for x, y, z in corners:
        mesh.Vertices.Add(x, y, z)
    mesh.Faces.AddFace(0, 1, 2, 3)
    model.Objects.AddMesh(mesh, on_layer(layer))


def main():
    model = rhino3dm.File3dm()
    model.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Millimeters
    room = add_layer(model, "OASIS room")
    windows = add_layer(model, "OASIS windows")

    L, W, H = 7000, 4500, 3000
    box = rhino3dm.BoundingBox(0, 0, 0, L, W, H)
    model.Objects.AddBrep(rhino3dm.Brep.CreateFromBoundingBox(box), on_layer(room))

    # South wall (y = 0): 1.8 x 1.2 m
    rectangle(model, [(2600, 0, 900), (4400, 0, 900), (4400, 0, 2100), (2600, 0, 2100)], windows)
    # North wall (y = W): 1.2 x 1.2 m
    rectangle(model, [(2900, W, 900), (4100, W, 900), (4100, W, 2100), (2900, W, 2100)], windows)
    # West wall (x = 0): 0.9 x 1.2 m
    rectangle(model, [(0, 1800, 900), (0, 2700, 900), (0, 2700, 2100), (0, 1800, 2100)], windows)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    model.Write(str(OUT), 7)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
