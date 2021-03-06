'use strict'

const debug = require('debug')('full-text-search-light')

function arrayUnique(array) {
  var a = []
  for (let i = 0, l = array.length; i < l; i++) {
    if (a.indexOf(array[i]) === -1) {
      a.push(array[i])
    }
  }
  return a
}

class FullTextSearchLight {
  constructor(options) {
    const defaultOptions = {
      index_amount: 12,
      ignore_case: true,
      only_prefix: false,
    }

    this.config = Object.assign(defaultOptions, options)

    this.indexes = []
    this.data = []
    this.data_ptr = 0
    this.free_slots = []
    this.single_data_counter = 0

    this.init()
  }

  init() {
    // Create indexes
    for (let i = 0; i < this.config.index_amount; i++) {
      this.indexes.push(Object.create(null))
    }
  }

  index_amount(amount) {
    if (amount) {
      this.config.index_amount = amount
      return
    }
    return this.config.index_amount
  }

  ignore_case(bool) {
    if (bool === true || bool === false) {
      this.config.ignore_case = bool
      return
    }
    return this.config.ignore_case
  }

  traverse(object, func, filter) {
    for (let key in object) {
      if (filter && filter(key, object) === false) {
        debug('Ignore field \'' + key + '\'')
        continue
      }

      // Only care about primitives
      if (object[key] !== null && (object[key].constructor === Number || object[key].constructor === String || object[key].constructor === Boolean)) {
        func.apply(this, [key, object[key]])
      }

      if (object[key] !== null && typeof(object[key]) == "object") {
        //going on step down in the object tree!!
        this.traverse(object[key], func, filter)
      }
    }
  }

  traverseCheck(obj, search, result) {
    this.traverse(obj, function(key, value) {
      // Already matched
      if (result.match === true) {
        return
      }

      let v = value

      if (value.constructor === String) {
        v = value
      }

      if (value.constructor === Number || value.constructor === Boolean) {
        v = value.toString()
      }

      if (this.config.ignore_case === true) {
        v = v.toLowerCase()
      }

      // Search term matched
      if (v.indexOf(search) > -1) {
        result.match = true
      }
    })
  }

  add(obj, filter) {
    // Define data index
    let index = this.nextFreeIndex()

    debug('Next free index for ' + JSON.stringify(obj) + ': ' + index)

    // Store data
    this.data[index] = obj

    // Add to index
    this.addToIndex(obj, index, filter)

    return index
  }

  addToIndex(obj, index, filter) {
    if (obj.constructor === String || obj.constructor === Number || obj.constructor === Boolean) {
      ++this.single_data_counter

      // Create all parts for all indexes
      for (let i = 0; i < this.indexes.length; i++) {
        let text
        if (obj.constructor === String) {
          debug('Type of data: String')
          text = this.config.ignore_case === true ? obj.toLowerCase() : obj
        }

        if (obj.constructor === Number || obj.constructor === Boolean) {
          debug('Type of data: Number | Boolean')
          text = obj.toString()
        }

        // Split into parts, care about case sensitivity
        let parts = this.cut(text, i + 1)
        debug('Parts for ' + JSON.stringify(obj) + ': ' + JSON.stringify(parts))

        // Stop if it is not splittable anymore
        if (parts.length == 0) {
          break
        }

        for (let j = 0; j < parts.length; j++) {
          if (!this.indexes[i][parts[j]]) {
            this.indexes[i][parts[j]] = []
          }

          // Level 1...n index, no duplicates
          if (this.indexes[i][parts[j]].indexOf(index) === -1) {
            this.indexes[i][parts[j]].push(index)
          }
        }
      }

      return
    }

    // Add object
    if (obj.constructor === Object || obj.constructor === Array || obj.constructor === Function) {
      this.traverse(obj, (key, value) => {
        this.addToIndex(value, index, filter)
      }, filter)
    }
  }

  search(text) {
    if (text === undefined || text === null || text === '') {
      return []
    }

    if (text.constructor === Number || text.constructor === Boolean) {
      text = text.toString()
    }

    if (this.config.ignore_case === true) {
      text = text.toLowerCase()
    }

    debug('Search for \'' + text + '\'')

    // 1) Search directly for the result
    if (text.length <= this.config.index_amount) {
      let index_nr = text.length - 1
      debug('Text length is ' + text.length + ' so search in index ' + index_nr)
      debug('Index ' + index_nr + ' is ' + JSON.stringify(this.indexes[index_nr]))

      let ids = this.indexes[index_nr][text]

      debug('Found ids for keyword \'' + text + '\': ' + JSON.stringify(ids))

      if (!ids || ids.length == 0) {
        debug('Index found but no ids found')
        return []
      }

      let result = []
      for (var i = 0; i < ids.length; i++) {
        result.push(this.data[ids[i]])
      }
      return result
    }

    // ---------- This code will be only be entered if the search index is to small for this search term -----------


    // 2) Seach indirectly
    debug('No matching index found, take the index with the longest words')
    let last_index = this.indexes[this.indexes.length - 1]
    let text_length = this.indexes.length
    let parts = this.cut(text, text_length)
    debug('Search for: ' + JSON.stringify(parts))

    let ids = []
    let parts_found_counter = 0
    for (let i = 0; i < parts.length; i++) {
      // Nothing found for that part
      if (!last_index[parts[i]]) {
        continue
      }

      ++parts_found_counter

      for (let j = 0; j < last_index[parts[i]].length; j++) {
        ids.push(last_index[parts[i]][j])
      }
    }

    debug('Found ids: ' + JSON.stringify(ids))

    // Nothing found || The index is to small for the complete search word so the word is splitted in the biggest
    // indexed size. If not every part has a match the result is not valid.
    // 1) Example:  the word 'simpler' is added to the fulltext search, the index amount is 3.
    //    Now we search for the word 'sximp'
    //      a) First the word is splitted to: 'sxi', 'xim', 'imp'
    //      b) 'sxi': 0 matches, , 'xim': 0 matches, 'imp': 1 match
    if (ids.length == 0 || parts_found_counter < parts.length) {
      debug('Nothing found for \'' + text + '\'')
      return []
    }


    // Count elements
    let counter = {}
    for (let i = 0; i < ids.length; i++) {
      if (!counter[ids[i]]) {
        counter[ids[i]] = 0
      }
      counter[ids[i]]++
    }

    debug('Count occurence ' + JSON.stringify(counter))

    let true_match_ids = []

    // if counter == parts.length then its a hit
    for (let key in counter) {
      if (counter[key] === parts.length) {
        true_match_ids.push(key)
      }
    }

    debug('True matching ids: ' + JSON.stringify(true_match_ids))

    let result = []
    for (let i = 0; i < true_match_ids.length; i++) {
      debug('Data for id \'' + true_match_ids[i] + '\': ' + JSON.stringify(this.data[true_match_ids[i]]))

      // String
      if (this.data[true_match_ids[i]].constructor === String) {
        debug('Data[' + true_match_ids[i] + '] is string')
        debug('\'' + this.data[true_match_ids[i]] + '\' contains \'' + text + '\'?')

        // Check if text is fully contained in the word
        if (this.data[true_match_ids[i]].toLowerCase().indexOf(text) > -1) {
          debug('Yes')
          result.push(this.data[true_match_ids[i]])
        }
        continue
      }

      if (this.data[true_match_ids[i]].constructor === Number || this.data[true_match_ids[i]].constructor === Boolean) {
        debug('Data[' + true_match_ids[i] + '] is boolean | number')

        // Check if text is fully contained in the number or boolean
        if (this.data[true_match_ids[i]].toString().indexOf(text)) {
          result.push(this.data[true_match_ids[i]])
        }
        continue
      }

      debug('Data[' + true_match_ids[i] + '] is object')

      // If its a complex object like an array...
      let resp = {
        match: false
      }

      this.traverseCheck(this.data[true_match_ids[i]], text, resp)
      if (resp.match === true) {
        result.push(this.data[true_match_ids[i]])
      }
    }
    return result
  }

  removeData(data_index) {
    // Remove data
    this.data[data_index] = undefined   // Just overwrite with undefined

    // Free for overwriting
    this.free_slots.push(data_index)

    debug('Add index data[' + data_index + '] to free slots: ' + JSON.stringify(this.free_slots))
  }

  remove(data_index) {
    debug('Remove data-index: ' + data_index)

    let obj = this.data[data_index]

    debug('Data for data-index \'' + data_index + '\' found: ' + JSON.stringify(obj))

    // Primitive
    if (obj.constructor === Number || obj.constructor === Boolean) {
      obj = obj.toString()
    }

    if (obj.constructor === String) {
      if (this.config.ignore_case === true) {
        obj = obj.toLowerCase()
      }

      // Create all parts for all indexes and remove all data_indexes
      // If the data_index is found
      for (let i = 0; i < this.indexes.length; i++) {
        let parts = this.cut(obj, i + 1)
        for (let j = 0; j < parts.length; j++) {
          this.removePrimitve(parts[j], data_index)
        }
      }

      this.removeData(data_index)
      return
    }

    // Complex Object
    this.traverse(obj, function(key, value) {
      if (value.constructor === Boolean || value.constructor === Number) {
        value = value.toString()
      }

      // Create all parts for all indexes and remove all data_indexes
      // If the data_index is found
      for (let i = 0; i < this.indexes.length; i++) {
        let parts = this.cut(value, i + 1)
        for (let j = 0; j < parts.length; j++) {
          this.removePrimitve(parts[j], data_index)
        }
      }
    })
    this.removeData(data_index)
  }

  removePrimitve(text, data_index) {
    debug('Remove primitive \'' + text + '\'.')

    // 1) Search directly for the result
    if (text.length <= this.config.index_amount) {
      let index_nr = text.length - 1

      debug('Text length is ' + text.length + ' so search in index ' + index_nr)
      debug('Index ' + index_nr + ' is ' + JSON.stringify(this.indexes[index_nr]))
      let ids = this.indexes[index_nr][text]

      // Remove data_id out of index
      debug('Remove id \'' + data_index + '\' from ' + text + ':\'' + JSON.stringify(ids) + '\'')
      this.removeFromArray(ids, data_index)

      // Is empty can be deleted, no further need
      if (ids.length == 0) {
        delete this.indexes[index_nr][text]
      }

      debug('Removed id, resulting ids are:' + JSON.stringify(ids))
      return
    }

    // 2) Search indirectly
    let last_index = this.indexes[this.indexes.length - 1]
    let text_length = this.indexes.length
    let parts = this.cut(text, text_length)

    debug('Search for \'' + JSON.stringify(parts) + '\'')

    for (let i = 0; i < parts.length; i++) {
      // Nothing found for that part
      if (!last_index[parts[i]]) {
        continue
      }

      debug('Remove \'' + data_index + '\' in ' + last_index[parts[i]])
      this.removeFromArray(last_index[parts[i]], data_index)
      // Is empty can be deleted, no further need
      if (last_index[parts[i]].length == 0) {
        delete last_index[parts[i]]
      }
    }
  }

  removeFromArray(arr, val) {
    for (let i = arr.length - 1; i > -1; i--) {
      if (arr[i] == val) {
        arr.splice(i, 1)
      }
    }
  }

  drop() {
    this.indexes = []
    this.data = []
    this.data_ptr = 0
    this.free_slots = []
    this.init()
  }

  nextFreeIndex() {
    return this.data_ptr++
  }

  cut(text, level) {
    if (level < 1) {
      throw new Error("Can't divide a word in parts smaller than 1 character")
    }

    if (text.constructor !== String) {
      throw new Error("Can't handle non-strings")
    }

    let parts = []
    if (this.config.only_prefix) {
      let words = text.split(' ')
      for (let i = 0; i < words.length; i++) {
        let word = words[i].trim()
        if (level > word.length) {
          continue
        }
        parts.push(word.substring(0, level))
      }
    } else {
      for (let i = 0; i < text.length; i++) {
        if (i + level > text.length) {
          break
        }
        parts.push(text.substring(i, i + level))
      }
    }

    return arrayUnique(parts)
  }
}

module.exports = FullTextSearchLight
