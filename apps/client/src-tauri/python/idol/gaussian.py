import numpy as np
import torch
import torch.nn.functional as F

PLY_PROPERTIES = ('x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
                  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3')


def inverse_sigmoid(x):
    return torch.log(x / (1 - x))


def inverse_softplus(x):
    return x + torch.log(-torch.expm1(-x))


class Gaussian:
    """Built from the Gaussian decoder's raw outputs; the activated values are what renderers and PLY files use.

    xyz [N, 3] positions, features_dc [N, 1, 3] colour (degree-0 spherical harmonics), scaling [N, 3],
    rotation [N, 4] unit quaternions (w, x, y, z), opacity [N, 1]. The object is z-up, inside [-0.5, 0.5]^3."""

    def __init__(self, raw_xyz, features_dc, raw_scaling, raw_rotation, raw_opacity,
                 scaling_bias: float, opacity_bias: float, minimum_kernel_size: float):
        device = raw_xyz.device
        aabb = torch.tensor([-0.5, -0.5, -0.5, 1.0, 1.0, 1.0], dtype=torch.float32, device=device)
        scaling_offset = inverse_softplus(torch.tensor(scaling_bias)).to(device)
        opacity_offset = inverse_sigmoid(torch.tensor(opacity_bias)).to(device)
        rotation_offset = torch.tensor([1.0, 0.0, 0.0, 0.0], device=device)

        self.xyz = raw_xyz * aabb[None, 3:] + aabb[None, :3]
        self.features_dc = features_dc
        scaling = F.softplus(raw_scaling + scaling_offset)
        self.scaling = torch.sqrt(torch.square(scaling) + minimum_kernel_size ** 2)
        self.rotation = F.normalize(raw_rotation + rotation_offset[None, :])
        self.opacity = torch.sigmoid(raw_opacity + opacity_offset)

    def __len__(self) -> int:
        return self.xyz.shape[0]

    def keep(self, mask: torch.Tensor) -> 'Gaussian':
        """A copy restricted to the Gaussians where mask is true."""
        kept = Gaussian.__new__(Gaussian)
        kept.xyz, kept.features_dc = self.xyz[mask], self.features_dc[mask]
        kept.scaling, kept.rotation, kept.opacity = self.scaling[mask], self.rotation[mask], self.opacity[mask]
        return kept

    def save_ply(self, path):
        """Write the standard binary 3D Gaussian Splatting PLY (z-up object turned to the y-up convention viewers
        use)."""
        xyz = self.xyz.detach().float().cpu().numpy()
        f_dc = self.features_dc.detach().float().transpose(1, 2).flatten(start_dim=1).contiguous().cpu().numpy()
        # Clamp before the inverse activations: a saturated opacity (exactly 1.0 after the sigmoid) or a zero
        # scale would otherwise be written as +/-inf, which some PLY viewers reject.
        eps = 1e-6
        opacities = inverse_sigmoid(self.opacity.float().clamp(eps, 1 - eps)).detach().cpu().numpy()
        scale = torch.log(self.scaling.float().clamp_min(eps)).detach().cpu().numpy()
        rotation = self.rotation.detach().float().cpu().numpy()

        # z-up -> y-up: rotate +90 degrees about x, i.e. (x, y, z) -> (x, -z, y)
        xyz = np.stack([xyz[:, 0], -xyz[:, 2], xyz[:, 1]], axis=1)
        rotation = quaternion_multiply(np.array([np.sqrt(0.5), np.sqrt(0.5), 0.0, 0.0]), rotation)

        attributes = np.concatenate((xyz, np.zeros_like(xyz), f_dc, opacities, scale, rotation), axis=1)
        attributes = np.ascontiguousarray(attributes, dtype='<f4')
        if not np.isfinite(attributes).all():
            raise ValueError('The generated Gaussians contain non-finite values')
        header = ['ply', 'format binary_little_endian 1.0', f'element vertex {attributes.shape[0]}']
        header += [f'property float {name}' for name in PLY_PROPERTIES]
        header.append('end_header')
        with open(path, 'wb') as output:
            output.write(('\n'.join(header) + '\n').encode('ascii'))
            output.write(attributes.tobytes())


def quaternion_multiply(a, b):
    """Hamilton product a * b of (w, x, y, z) quaternions; a is one quaternion, b is (N, 4)."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    return np.stack([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ], axis=1)
