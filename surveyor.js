const fs = require('fs')
const path = require('path')
const H = require('highland')
const R = require('ramda')
const got = require('got')
const turf = {
  distance: require('@turf/distance')
}
const clusterfck = require('clusterfck')

const url = 'http://brick-by-brick.herokuapp.com/tasks/geotag-photo/submissions/all.ndjson'
const filename = 'brick-by-brick-submissions.ndjson'

// Read from Space/Time ETL config
const MIN_SUBMISSIONS_PER_PHOTO = 3
const MIN_LOCATION_ZOOM = 13
const MAX_DISTANCE = 50

function getPhotoId (item) {
  return `${item.organization.id}-${item.item.id}`
}

function download (config, dirs, tools, callback) {
  got.stream(url)
    .pipe(fs.createWriteStream(path.join(dirs.current, filename)))
    .on('finish', callback)
}

function flattenTree (tree) {
  if (tree) {
    if (tree.value) {
      return [tree.value]
    } else {
        return [...flattenTree(tree.left), ...flattenTree(tree.right)]
    }
  }
}

function removeOutliers (item) {
  const locations = R.flatten(item.submissions
    .map((submission, index) => submission.steps
      .filter((step) => step.step === 'location')
      .filter((step) => step.data.zoom >= MIN_LOCATION_ZOOM)
      .map((step) => Object.assign(step, {
        submissionIndex: index
      }))
    ))

  if (locations.length < MIN_SUBMISSIONS_PER_PHOTO) {
    return
  }

  const distance = (a, b) => turf.distance(a.data.geometry, b.data.geometry, 'meters')
  const clusters = clusterfck.hcluster(locations, distance, 'single', MAX_DISTANCE)
    .sort((a, b) => b.size - a.size)

  if (clusters.length > 1 && (clusters[0].size === clusters[1].size)) {
    return
  }

  const clusterLocations = flattenTree(clusters[0])
    .sort((a, b) => b.data.zoom - a.data.zoom)

  const clusterSubmissions = clusterLocations
    .map((submission) => item.submissions[submission.submissionIndex])
    .sort((a, b) => b.steps.length - b.steps.length)

  const submission = clusterSubmissions[0]

  return Object.assign(item, {
    clusterSize: clusters[0].size,
    location: submission.steps[0].data.geometry,
    bearing: submission.steps[1] && submission.steps[1].data.geometry
  })
}

function transform (config, dirs, tools, callback) {
  H(fs.createReadStream(path.join(dirs.download, filename)))
    .split()
    .compact()
    .map(JSON.parse)
    .filter((item) => {
      return item.submissions.length >= MIN_SUBMISSIONS_PER_PHOTO
    })
    .map(removeOutliers)
    .compact()
    .map((item) => ({
      type: 'object',
      obj: {
        id: getPhotoId(item),
        type: 'st:Photo',
        name: item.item.data.title,
        // validSince: item.item.data.date,
        // validUntil: item.item.data.date,
        data: Object.assign({
          id: item.item.id,
          organizationId: item.organization.id,
          submissions: item.submissions.length,
          clusterSize: item.clusterSize,
          data: item.data,
          type: item.bearing ? 'bearing' : 'location'
        }),
        geometry: item.bearing || item.location
      }
    }))
    .map(H.curry(tools.writer.writeObject))
    .nfcall([])
    .series()
    .stopOnError(callback)
    .done(callback)
}

// ==================================== API ====================================

module.exports.steps = [
  download,
  transform
]
