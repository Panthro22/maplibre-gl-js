import {CanonicalTileID, OverscaledTileID} from './tile_id';
import {Event, ErrorEvent, Evented} from '../util/evented';
import {ImageRequest} from '../util/image_request';
import {ResourceType} from '../util/request_manager';
import {EXTENT} from '../data/extent';
import {RasterBoundsArray} from '../data/array_types.g';
import rasterBoundsAttributes from '../data/raster_bounds_attributes';
import {SegmentVector} from '../data/segment';
import {Texture} from '../render/texture';
import {MercatorCoordinate} from '../geo/mercator_coordinate';
import {Tile} from './tile';

import type {Source} from './source';
import type {CanvasSourceSpecification} from './canvas_source';
import type {Map} from '../ui/map';
import type {Dispatcher} from '../util/dispatcher';
import type {VertexBuffer} from '../gl/vertex_buffer';
import type {
    ImageSourceSpecification,
    VideoSourceSpecification
} from '@maplibre/maplibre-gl-style-spec';

/**
 * Four geographical coordinates,
 * represented as arrays of longitude and latitude numbers, which define the corners of the image.
 * The coordinates start at the top left corner of the image and proceed in clockwise order.
 * They do not have to represent a rectangle.
 */
export type Coordinates = [[number, number], [number, number], [number, number], [number, number]];

/**
 * The options object for the {@link ImageSource#updateImage} method
 */
export type UpdateImageOptions = {
    /**
     * Required image URL.
     */
    url: string;
    /**
     * The image coordinates
     */
    coordinates?: Coordinates;
}

/**
 * A data source containing an image.
 * (See the [Style Specification](https://maplibre.org/maplibre-style-spec/#sources-image) for detailed documentation of options.)
 *
 * @group Sources
 *
 * @example
 * ```ts
 * // add to map
 * map.addSource('some id', {
 *    type: 'image',
 *    url: 'https://www.maplibre.org/images/foo.png',
 *    coordinates: [
 *        [-76.54, 39.18],
 *        [-76.52, 39.18],
 *        [-76.52, 39.17],
 *        [-76.54, 39.17]
 *    ]
 * });
 *
 * // update coordinates
 * let mySource = map.getSource('some id');
 * mySource.setCoordinates([
 *     [-76.54335737228394, 39.18579907229748],
 *     [-76.52803659439087, 39.1838364847587],
 *     [-76.5295386314392, 39.17683392507606],
 *     [-76.54520273208618, 39.17876344106642]
 * ]);
 *
 * // update url and coordinates simultaneously
 * mySource.updateImage({
 *    url: 'https://www.maplibre.org/images/bar.png',
 *    coordinates: [
 *        [-76.54335737228394, 39.18579907229748],
 *        [-76.52803659439087, 39.1838364847587],
 *        [-76.5295386314392, 39.17683392507606],
 *        [-76.54520273208618, 39.17876344106642]
 *    ]
 * })
 *
 * map.removeSource('some id');  // remove
 * ```
 */
export class ImageSource extends Evented implements Source {
    type: string;
    id: string;
    firstIteration = true;
    minzoom: number;
    maxzoom: number;
    tileSize: number;
    url: string;

    coordinates: Coordinates;
    cornerCoords: MercatorCoordinate[];
    tiles: {[_: string]: Tile};
    options: any;
    dispatcher: Dispatcher;
    map: Map;
    texture: Texture | null;
    image: HTMLImageElement | ImageBitmap;
    tileID: CanonicalTileID;
    imageOverlapedTileIDs: CanonicalTileID[];
    _boundsArray: RasterBoundsArray;
    _boundsArrayOfOverLappedTiles: {[_: string]: RasterBoundsArray};
    boundsBuffer: VertexBuffer;
    boundsBufferOverLappedTiles: {[_: string]: VertexBuffer};
    boundsSegments: SegmentVector;
    _loaded: boolean;
    _request: AbortController;

    /** @internal */
    constructor(id: string, options: ImageSourceSpecification | VideoSourceSpecification | CanvasSourceSpecification, dispatcher: Dispatcher, eventedParent: Evented) {
        super();
        this.id = id;
        this.dispatcher = dispatcher;
        this.coordinates = options.coordinates;

        this.type = 'image';
        this.minzoom = 0;
        this.maxzoom = 22;
        this.tileSize = 512;
        this.tiles = {};
        this._loaded = false;
        this._boundsArrayOfOverLappedTiles = {};
        this.boundsBufferOverLappedTiles = {};
        this.setEventedParent(eventedParent);

        // Compute what other tiles the image overlaps into and
        // excludes the tile holding the source.
        if (this.firstIteration) {
            // transform the geo coordinates into (zoom 0) tile space coordinates
            const cornerCoords = options.coordinates.map(MercatorCoordinate.fromLngLat);
            // Sets the initial tile value for first time creating the source.
            this.tileID = getCoordinatesCenterTileID(cornerCoords);
            this.imageOverlapedTileIDs = getMediaOverlapTileIds(cornerCoords, this.tileID);
        }

        this.options = options;
    }

    async load(newCoordinates?: Coordinates): Promise<void> {
        this._loaded = false;
        this.fire(new Event('dataloading', {dataType: 'source'}));

        this.url = this.options.url;

        this._request = new AbortController();
        try {
            const image = await ImageRequest.getImage(this.map._requestManager.transformRequest(this.url, ResourceType.Image), this._request);
            this._request = null;
            this._loaded = true;

            if (image && image.data) {
                this.image = image.data;
                if (newCoordinates) {
                    this.coordinates = newCoordinates;
                }
                this._finishLoading();
            }
        } catch (err) {
            this._request = null;
            this._loaded = true;
            this.fire(new ErrorEvent(err));
        }
    }

    loaded(): boolean {
        return this._loaded;
    }

    /**
     * Updates the image URL and, optionally, the coordinates. To avoid having the image flash after changing,
     * set the `raster-fade-duration` paint property on the raster layer to 0.
     *
     * @param options - The options object.
     * @returns `this`
     */
    updateImage(options: UpdateImageOptions): this {
        if (!options.url) {
            return this;
        }

        if (this._request) {
            this._request.abort();
            this._request = null;
        }

        this.options.url = options.url;
        this.load(options.coordinates).finally(() => { this.texture = null; });
        return this;
    }

    _finishLoading() {
        if (this.map) {
            this.setCoordinates(this.coordinates);
            this.fire(new Event('data', {dataType: 'source', sourceDataType: 'metadata'}));
        }
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
    }

    onRemove() {
        if (this._request) {
            this._request.abort();
            this._request = null;
        }
    }

    /**
     * Sets the image's coordinates and re-renders the map.
     *
     * @param coordinates - Four geographical coordinates,
     * represented as arrays of longitude and latitude numbers, which define the corners of the image.
     * The coordinates start at the top left corner of the image and proceed in clockwise order.
     * They do not have to represent a rectangle.
     * @returns `this`
     */
    setCoordinates(coordinates: Coordinates): this {
        this.coordinates = coordinates;

        // Calculate which mercator tile is suitable for rendering the video in
        // and create a buffer with the corner coordinates. These coordinates
        // may be outside the tile, because raster tiles aren't clipped when rendering.

        // transform the geo coordinates into (zoom 0) tile space coordinates
        this.cornerCoords = coordinates.map(MercatorCoordinate.fromLngLat);

        // Constrain min/max zoom to our tile's zoom level in order to force
        // SourceCache to request this tile (no matter what the map's zoom
        // level)
        this.minzoom = this.maxzoom = this.tileID.z;

        // Transform the corner coordinates into the coordinate space of our
        // tile.
        const tileCoords = this.cornerCoords.map((coord) => this.tileID.getTilePoint(coord)._round());

        this._boundsArray = new RasterBoundsArray();
        this._boundsArray.emplaceBack(tileCoords[0].x, tileCoords[0].y, 0, 0);
        this._boundsArray.emplaceBack(tileCoords[1].x, tileCoords[1].y, EXTENT, 0);
        this._boundsArray.emplaceBack(tileCoords[3].x, tileCoords[3].y, 0, EXTENT);
        this._boundsArray.emplaceBack(tileCoords[2].x, tileCoords[2].y, EXTENT, EXTENT);

        if (this.imageOverlapedTileIDs.length > 1) {
            this.setOverlappedCoordinates();
        }

        if (this.boundsBuffer) {
            this.boundsBuffer.destroy();
            delete this.boundsBuffer;
        }

        this.fire(new Event('data', {dataType: 'source', sourceDataType: 'content'}));
        return this;
    }

    // Handles getting the needed information a source requires for the other tiles areas
    setOverlappedCoordinates() {

        for (const tileId of this.imageOverlapedTileIDs) {
            // Transform the corner coordinates into the coordinate space of each
            // tile.
            const tileCoords = this.cornerCoords.map((coord) => tileId.getTilePoint(coord)._round());

            const _overlappedBoundsArray = new RasterBoundsArray();
            _overlappedBoundsArray.emplaceBack(tileCoords[0].x, tileCoords[0].y, 0, 0);
            _overlappedBoundsArray.emplaceBack(tileCoords[1].x, tileCoords[1].y, EXTENT, 0);
            _overlappedBoundsArray.emplaceBack(tileCoords[3].x, tileCoords[3].y, 0, EXTENT);
            _overlappedBoundsArray.emplaceBack(tileCoords[2].x, tileCoords[2].y, EXTENT, EXTENT);

            this._boundsArrayOfOverLappedTiles[tileId.key] = _overlappedBoundsArray;
        }

        if (this.boundsBufferOverLappedTiles) {
            for (const tileId of this.imageOverlapedTileIDs) {
                this.boundsBufferOverLappedTiles[tileId.key] = null;
            }
            delete this.boundsBufferOverLappedTiles;
        }
    }

    prepare() {
        if (Object.keys(this.tiles).length === 0 || !this.image) {
            return;
        }

        const context = this.map.painter.context;
        const gl = context.gl;

        if (!this.boundsBuffer) {
            this.boundsBuffer = context.createVertexBuffer(this._boundsArray, rasterBoundsAttributes.members);
        }

        if (!this.boundsBufferOverLappedTiles) {
            this.boundsBufferOverLappedTiles = {};
            for (const id in this._boundsArrayOfOverLappedTiles) {
                this.boundsBufferOverLappedTiles[id] = context.createVertexBuffer(this._boundsArrayOfOverLappedTiles[id], rasterBoundsAttributes.members);
            }
        }

        if (!this.boundsSegments) {
            this.boundsSegments = SegmentVector.simpleSegment(0, 0, 4, 2);
        }

        if (!this.texture) {
            this.texture = new Texture(context, this.image, gl.RGBA);
            this.texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
        }

        let newTilesLoaded = false;
        for (const w in this.tiles) {
            const tile = this.tiles[w];
            if (tile.state !== 'loaded') {
                tile.state = 'loaded';
                tile.texture = this.texture;
                newTilesLoaded = true;
            }
        }

        if (newTilesLoaded) {
            this.fire(new Event('data', {dataType: 'source', sourceDataType: 'idle', sourceId: this.id}));
        }
    }

    async loadTile(tile: Tile): Promise<void> {
        // We have a single tile -- whose coordinates are this.tileID -- that
        // covers the image we want to render.  If that's the one being
        // requested, set it up with the image; otherwise, mark the tile as
        // `errored` to indicate that we have no data for it.
        // If the world wraps, we may have multiple "wrapped" copies of the
        // single tile.
        if ((this.tileID && this.tileID.equals(tile.tileID.canonical)) || !this.imageOverlapedTileIDs.includes(tile.tileID.canonical)) {
            this.tiles[String(tile.tileID.key)] = tile;
            tile.buckets = {};
        } else {
            tile.state = 'errored';
        }
    }

    serialize(): ImageSourceSpecification | VideoSourceSpecification | CanvasSourceSpecification {
        return {
            type: 'image',
            url: this.options.url,
            coordinates: this.coordinates
        };
    }

    hasTransition() {
        return false;
    }

    updateTileId(tileId: CanonicalTileID) {
        this.tileID = tileId;
    }

    hasTile(tileID: OverscaledTileID): boolean {
        return this.imageOverlapedTileIDs.includes(tileID.canonical) || this.tileID === tileID.canonical;
    }
}

/**
 * Given a list of coordinates, get their center as a coordinate.
 *
 * @returns centerpoint
 * @internal
 */
export function getCoordinatesCenterTileID(coords: Array<MercatorCoordinate>) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const coord of coords) {
        minX = Math.min(minX, coord.x);
        minY = Math.min(minY, coord.y);
        maxX = Math.max(maxX, coord.x);
        maxY = Math.max(maxY, coord.y);
    }

    const dx = maxX - minX;
    const dy = maxY - minY;
    const dMax = Math.max(dx, dy);
    const zoom = Math.max(0, Math.floor(-Math.log(dMax) / Math.LN2));
    const tilesAtZoom = Math.pow(2, zoom);

    return new CanonicalTileID(
        zoom,
        Math.floor((minX + maxX) / 2 * tilesAtZoom),
        Math.floor((minY + maxY) / 2 * tilesAtZoom));
}

/**
 * Given a list of coordinates, get the tiles they touch coordinates.
 *
 * @returns other tiles that image or video crosses into.
 * @internal
 */
export function getMediaOverlapTileIds(coords: MercatorCoordinate[], tileID: CanonicalTileID): Array<CanonicalTileID> {
    const tilesOverlapedByImageIDs: Array<CanonicalTileID> = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const coord of coords) {
        minX = Math.min(minX, coord.x);
        minY = Math.min(minY, coord.y);
        maxX = Math.max(maxX, coord.x);
        maxY = Math.max(maxY, coord.y);
    }
    for (const coord of coords) {
        const dx = maxX - minX;
        const dy = maxY - minY;
        const dMax = Math.max(dx, dy);
        const zoom = Math.max(0, Math.floor(-Math.log(dMax) / Math.LN2));
        const tilesAtZoom = Math.pow(2, tileID.z);
        const borderTileId = new CanonicalTileID(
            zoom,
            Math.floor(coord.x * tilesAtZoom),
            Math.floor(coord.y * tilesAtZoom)
        );
        if (tileID.key !== borderTileId.key) {
            tilesOverlapedByImageIDs.push(borderTileId);
            for (let index = 0; index < tilesOverlapedByImageIDs.length - 1; index++) {
                if (tilesOverlapedByImageIDs[index].x === borderTileId.x && tilesOverlapedByImageIDs[index].y === borderTileId.y) {
                    tilesOverlapedByImageIDs.pop();
                }
            }
        }
    }
    return tilesOverlapedByImageIDs;

}

