/**
 * Returns 'image' or 'video' for a given scene index and niche style.
 */
function getSceneMediaType(sceneIndex, styleType, styleConfig) {
  switch (styleType) {
    case 'all_video': return 'video';
    case 'all_image': return 'image';
    case 'alternating': {
      const startWithVideo = styleConfig.startWith === 'video';
      return (sceneIndex % 2 === 0) === startWithVideo ? 'video' : 'image';
    }
    case 'first_n_video': {
      return sceneIndex < (styleConfig.n || 5) ? 'video' : 'image';
    }
    default: return 'image';
  }
}

module.exports = { getSceneMediaType };
