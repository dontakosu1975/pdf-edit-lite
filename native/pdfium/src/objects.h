/**
 * objects.h — Page object inspection and editing declarations.
 */
#ifndef PDFIUM_ADDON_OBJECTS_H
#define PDFIUM_ADDON_OBJECTS_H

#include <napi.h>

/**
 * listPageObjects(handle, pageIndex)
 * → Array<{ id, type, left, top, right, bottom }>
 */
Napi::Value ListPageObjects(const Napi::CallbackInfo& info);

/**
 * editTextObject(handle, pageIndex, objectId, newText, fontName?, fontSize?, fontData?, textColor?, fontScale?)
 * → void
 */
void EditTextObject(const Napi::CallbackInfo& info);

/**
 * insertTextObject(handle, pageIndex, x, y, newText, fontData, fontSize?)
 * → object id
 */
Napi::Value InsertTextObject(const Napi::CallbackInfo& info);

/**
 * removeTextObject(handle, pageIndex, objectId)
 * → void
 */
void RemoveTextObject(const Napi::CallbackInfo& info);

/**
 * moveTextObject(handle, pageIndex, objectId, dx, dy)
 * → void
 */
void MoveTextObject(const Napi::CallbackInfo& info);

/**
 * replaceImageObject(handle, pageIndex, objectId, imageData, format)
 * → void
 */
void ReplaceImageObject(const Napi::CallbackInfo& info);

/**
 * replaceImageObjectBitmap(handle, pageIndex, objectId, bgraData, width, height)
 * → void
 * Replaces an image object using raw BGRA pixel data.
 */
void ReplaceImageObjectBitmap(const Napi::CallbackInfo& info);

#endif // PDFIUM_ADDON_OBJECTS_H
